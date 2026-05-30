import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";

// Types
interface OnlineUser {
  socketId: string;
  userId: string;
  userName: string;
  connectedAt: Date;
}

interface UserActivity {
  userId: string;
  lastActive: Date;
  currentRoom?: string;
}

class SocketService {
  private io: SocketServer | null = null;
  private onlineUsers: Map<string, OnlineUser> = new Map(); // socketId -> OnlineUser
  private userSockets: Map<string, string[]> = new Map(); // userId -> socketIds[]
  private userActivities: Map<string, UserActivity> = new Map();

  initialize(server: HttpServer) {
    this.io = new SocketServer(server, {
      cors: {
        origin: process.env.CLIENT_URL
          ? process.env.CLIENT_URL.split(",").map((url) => url.trim())
          : true,
        credentials: true,
        methods: ["GET", "POST"],
      },
      // Connection timeout
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.io.use((socket, next) => {
      // Optional: Add authentication middleware
      const token = socket.handshake.auth.token;
      // You can verify JWT token here if needed
      next();
    });

    this.io.on("connection", (socket: Socket) => {
      console.log(`🔌 New client connected: ${socket.id}`);

      this.handleConnection(socket);

      const auth = socket.handshake.auth as {
        userId?: string;
        userName?: string;
      };

      if (auth.userId && auth.userName) {
        this.handleUserOnline(socket, {
          userId: auth.userId,
          userName: auth.userName,
        });
      }

      socket.on("user:online", (data) => this.handleUserOnline(socket, data));
      socket.on("user:typing", (data) => this.handleTyping(socket, data));
      socket.on("user:join-room", (data) => this.handleJoinRoom(socket, data));
      socket.on("user:leave-room", (data) =>
        this.handleLeaveRoom(socket, data),
      );
      socket.on("disconnect", () => this.handleDisconnect(socket));
    });

    console.log("✅ Socket.IO server initialized");
  }

  private handleConnection(socket: Socket) {
    // Send current online users to new client
    const onlineUsersList = Array.from(this.onlineUsers.values());
    socket.emit("online-users:list", onlineUsersList);

    // Emit total online count to all
    this.io?.emit("online-users:count", {
      count: this.onlineUsers.size,
      timestamp: new Date(),
    });
  }

  private handleUserOnline(
    socket: Socket,
    data: { userId: string; userName: string },
  ) {
    const { userId, userName } = data;

    // Store user connection
    const onlineUser: OnlineUser = {
      socketId: socket.id,
      userId,
      userName,
      connectedAt: new Date(),
    };

    this.onlineUsers.set(socket.id, onlineUser);

    // Track user's multiple sockets (for multi-device support)
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, []);
    }
    this.userSockets.get(userId)?.push(socket.id);

    // Initialize user activity
    this.userActivities.set(userId, {
      userId,
      lastActive: new Date(),
    });

    // Broadcast new online user to all other clients
    socket.broadcast.emit("user:online", onlineUser);

    // Update count for all
    this.io?.emit("online-users:count", {
      count: this.onlineUsers.size,
      timestamp: new Date(),
    });

    console.log(
      `✅ User online: ${userName} (${userId}) - Total online: ${this.onlineUsers.size}`,
    );
  }

  private handleTyping(
    socket: Socket,
    data: {
      userId: string;
      userName: string;
      isTyping: boolean;
      room?: string;
    },
  ) {
    const { userId, userName, isTyping, room } = data;

    const emitData = {
      userId,
      userName,
      isTyping,
      timestamp: new Date(),
    };

    if (room) {
      // Emit to specific room
      socket.to(room).emit("user:typing", emitData);
    } else {
      // Broadcast to everyone except sender
      socket.broadcast.emit("user:typing", emitData);
    }
  }

  private handleJoinRoom(
    socket: Socket,
    data: { userId: string; room: string },
  ) {
    const { userId, room } = data;
    socket.join(room);

    // Update user activity
    const activity = this.userActivities.get(userId);
    if (activity) {
      activity.currentRoom = room;
      activity.lastActive = new Date();
      this.userActivities.set(userId, activity);
    }

    // Notify room members
    socket.to(room).emit("room:user-joined", {
      userId,
      room,
      timestamp: new Date(),
    });

    console.log(`User ${userId} joined room: ${room}`);
  }

  private handleLeaveRoom(
    socket: Socket,
    data: { userId: string; room: string },
  ) {
    const { userId, room } = data;
    socket.leave(room);

    // Update user activity
    const activity = this.userActivities.get(userId);
    if (activity && activity.currentRoom === room) {
      activity.currentRoom = undefined;
      activity.lastActive = new Date();
      this.userActivities.set(userId, activity);
    }

    // Notify room members
    socket.to(room).emit("room:user-left", {
      userId,
      room,
      timestamp: new Date(),
    });

    console.log(`User ${userId} left room: ${room}`);
  }

  private handleDisconnect(socket: Socket) {
    const onlineUser = this.onlineUsers.get(socket.id);

    if (onlineUser) {
      const { userId, userName } = onlineUser;

      // Remove from online users
      this.onlineUsers.delete(socket.id);

      // Remove from user sockets
      const userSocketIds = this.userSockets.get(userId);
      if (userSocketIds) {
        const index = userSocketIds.indexOf(socket.id);
        if (index > -1) userSocketIds.splice(index, 1);

        if (userSocketIds.length === 0) {
          this.userSockets.delete(userId);
          this.userActivities.delete(userId);

          // Only broadcast disconnect if no other sockets for this user
          this.io?.emit("user:offline", {
            userId,
            userName,
            timestamp: new Date(),
          });
        }
      }

      // Update count
      this.io?.emit("online-users:count", {
        count: this.onlineUsers.size,
        timestamp: new Date(),
      });

      console.log(
        `❌ User offline: ${userName} (${userId}) - Total online: ${this.onlineUsers.size}`,
      );
    }

    console.log(`🔌 Client disconnected: ${socket.id}`);
  }

  // Public methods for external use
  emitToUser(userId: string, event: string, data: any) {
    const socketIds = this.userSockets.get(userId);
    if (socketIds) {
      socketIds.forEach((socketId) => {
        this.io?.to(socketId).emit(event, data);
      });
    }
  }

  emitToRoom(room: string, event: string, data: any) {
    this.io?.to(room).emit(event, data);
  }

  broadcast(event: string, data: any) {
    this.io?.emit(event, data);
  }

  getOnlineUsers(): OnlineUser[] {
    return Array.from(this.onlineUsers.values());
  }

  getOnlineUsersCount(): number {
    return this.onlineUsers.size;
  }

  getUserActivity(userId: string): UserActivity | undefined {
    return this.userActivities.get(userId);
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}

export const socketService = new SocketService();
