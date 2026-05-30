# Use official Node image (Ubuntu-based internally)
FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json bun.lockb* ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Generate Prisma client (DB migrations run at container start)
RUN bunx prisma generate


# Expose port
EXPOSE 5678

# Start the application
CMD ["bun", "run", "start"]