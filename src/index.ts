import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
import { createClient } from "redis";
import { prisma, connectDB, getQueryStats, resetQueryStats, checkConnection, disconnectDB } from "./config/db";
import { socketService } from "./service/socketService";
import { User } from "./generated/prisma/client";
import path from "path";
import { fileURLToPath } from "url";
// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

dotenv.config();

// ===============================
// REDIS SETUP
// ===============================
const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on("error", (err) => console.error("Redis error:", err));

await redisClient.connect();

// ===============================
// EXPRESS APP & HTTP SERVER
// ===============================
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
socketService.initialize(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to database on startup
await connectDB();

// Serve static files from project-root 'public' directory
app.use(express.static(publicDir));

// ===============================
// USER CRUD OPERATIONS
// ===============================

// GET all users
app.get("/api/v1/users", async (req, res) => {
  try {
    const cacheKey = "users:all";
    const cachedData = await redisClient.get(cacheKey);

    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    const users = await prisma.user.findMany({
      include: {
        todos: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Add online status to each user
    const usersWithOnlineStatus = users.map((user: User) => ({
      ...user,
      isOnline: socketService.isUserOnline(user.id),
    }));

    await redisClient.set(cacheKey, JSON.stringify(usersWithOnlineStatus), {
      EX: 60,
    });

    res.json(usersWithOnlineStatus);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET single user
app.get("/api/v1/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `user:${id}`;
    const cachedData = await redisClient.get(cacheKey);

    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        todos: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const userWithOnlineStatus = {
      ...user,
      isOnline: socketService.isUserOnline(user.id),
    };

    await redisClient.set(cacheKey, JSON.stringify(userWithOnlineStatus), {
      EX: 60,
    });

    res.json(userWithOnlineStatus);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// CREATE user
app.post("/api/v1/users", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required" });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email,
      },
    });

    // Invalidate cache
    await redisClient.del("users:all");

    // Broadcast new user to all connected clients
    socketService.broadcast("user:created", user);

    res.status(201).json(user);
  } catch (error: any) {
    console.error("Error creating user:", error);

    if (error.code === "P2002") {
      return res.status(409).json({ error: "Email already exists" });
    }

    res.status(500).json({ error: "Failed to create user" });
  }
});

// UPDATE user
app.put("/api/v1/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email && { email }),
      },
    });

    // Invalidate caches
    await redisClient.del(`user:${id}`);
    await redisClient.del("users:all");

    // Broadcast update to the specific user
    socketService.emitToUser(id, "user:updated", user);

    res.json(user);
  } catch (error: any) {
    console.error("Error updating user:", error);

    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }

    if (error.code === "P2002") {
      return res.status(409).json({ error: "Email already exists" });
    }

    res.status(500).json({ error: "Failed to update user" });
  }
});

// DELETE user
app.delete("/api/v1/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.user.delete({
      where: { id },
    });

    // Invalidate caches
    await redisClient.del(`user:${id}`);
    await redisClient.del("users:all");

    // Broadcast deletion
    socketService.broadcast("user:deleted", { id });

    res.status(204).send();
  } catch (error: any) {
    console.error("Error deleting user:", error);

    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ===============================
// TODO CRUD OPERATIONS
// ===============================

// GET all todos for a user
app.get("/api/v1/users/:userId/todos", async (req, res) => {
  try {
    const { userId } = req.params;
    const cacheKey = `user:${userId}:todos`;
    const cachedData = await redisClient.get(cacheKey);

    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    const todos = await prisma.todo.findMany({
      where: { userId },
      orderBy: {
        createdAt: "desc",
      },
    });

    await redisClient.set(cacheKey, JSON.stringify(todos), {
      EX: 60,
    });

    res.json(todos);
  } catch (error) {
    console.error("Error fetching todos:", error);
    res.status(500).json({ error: "Failed to fetch todos" });
  }
});

// CREATE todo
app.post("/api/v1/users/:userId/todos", async (req, res) => {
  try {
    const { userId } = req.params;
    const { title, completed = false } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const todo = await prisma.todo.create({
      data: {
        title,
        completed,
        userId,
      },
    });

    // Invalidate cache
    await redisClient.del(`user:${userId}:todos`);

    // Emit real-time update to the user
    socketService.emitToUser(userId, "todo:created", todo);

    res.status(201).json(todo);
  } catch (error) {
    console.error("Error creating todo:", error);
    res.status(500).json({ error: "Failed to create todo" });
  }
});

// UPDATE todo
app.put("/api/v1/todos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, completed } = req.body;

    const todo = await prisma.todo.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(completed !== undefined && { completed }),
      },
    });

    // Invalidate cache
    await redisClient.del(`user:${todo.userId}:todos`);

    // Emit real-time update
    socketService.emitToUser(todo.userId, "todo:updated", todo);

    res.json(todo);
  } catch (error: any) {
    console.error("Error updating todo:", error);

    if (error.code === "P2025") {
      return res.status(404).json({ error: "Todo not found" });
    }

    res.status(500).json({ error: "Failed to update todo" });
  }
});

// DELETE todo
app.delete("/api/v1/todos/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const todo = await prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    await prisma.todo.delete({
      where: { id },
    });

    // Invalidate cache
    await redisClient.del(`user:${todo.userId}:todos`);

    // Emit real-time deletion
    socketService.emitToUser(todo.userId, "todo:deleted", { id });

    res.status(204).send();
  } catch (error: any) {
    console.error("Error deleting todo:", error);

    if (error.code === "P2025") {
      return res.status(404).json({ error: "Todo not found" });
    }

    res.status(500).json({ error: "Failed to delete todo" });
  }
});

// ===============================
// WEBSOCKET STATUS ENDPOINTS
// ===============================

// Get online users
app.get("/api/v1/online-users", (req, res) => {
  res.json({
    count: socketService.getOnlineUsersCount(),
    users: socketService.getOnlineUsers(),
  });
});

// Get user online status
app.get("/api/v1/users/:id/online-status", (req, res) => {
  const { id } = req.params;
  res.json({
    userId: id,
    isOnline: socketService.isUserOnline(id),
    activity: socketService.getUserActivity(id),
  });
});

// ===============================
// QUERY PERFORMANCE ENDPOINTS
// ===============================

// Get query performance statistics
app.get("/api/v1/performance/stats", (req, res) => {
  const stats = getQueryStats();
  res.json({
    totalQueries: stats.length,
    queries: stats.slice(0, 50),
  });
});

// Reset query statistics
app.post("/api/v1/performance/reset", (req, res) => {
  resetQueryStats();
  res.json({ message: "Query stats reset successfully" });
});

// ===============================
// HEALTH CHECK
// ===============================
app.get("/api/v1/health", async (req, res) => {
  const { connected, error } = await checkConnection();

  res.json({
    status: connected ? "healthy" : "unhealthy",
    database: connected ? "connected" : "disconnected",
    websocket: socketService.getOnlineUsersCount() >= 0 ? "active" : "inactive",
    onlineUsers: socketService.getOnlineUsersCount(),
    timestamp: new Date(),
    error: error || null,
  });
});

// ===============================
// CLIENT ROUTES (after API)
// ===============================
app.get(["/", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(publicDir, "about.html"));
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`🔌 WebSocket server running on ws://${HOST}:${PORT}`);
  console.log(
    `📊 Query stats available at http://localhost:${PORT}/api/v1/performance/stats`,
  );
  console.log(`❤️  Health check at http://localhost:${PORT}/api/v1/health`);
  console.log(
    `👥 Online users endpoint at http://localhost:${PORT}/api/v1/online-users`,
  );
});

// ===============================
// GRACEFUL SHUTDOWN
// ===============================
const gracefulShutdown = async () => {
  console.log("\n🛑 Received shutdown signal, closing connections...");

  try {
    await redisClient.quit();
    console.log("✅ Redis disconnected");

    await disconnectDB();

    httpServer.close(() => {
      console.log("✅ HTTP/WebSocket server closed");
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
