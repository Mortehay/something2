"Act as a Senior DevOps and Game Backend Engineer. I have a project with ./backend (Node.js), ./frontend (JS), and ./compose (Docker).

Task: Create a high-performance Go WebSocket engine in ./engine.

Requirements:

Docker Integration: Update ./compose/docker-compose.yml to include the game-engine service, linking it to the existing Postgres and Redis containers.

Makefile Update: Add targets to the root Makefile for engine-build, engine-test, and engine-up.

Go Implementation:

Implement the WebSocket server using gorilla/websocket.

Add a JWT validation middleware using a shared secret from the .env file.

Implement a 60-tick game loop with a simple Grid-based Spatial Hash for 2D collisions between players and 'mods'.

State & DB:

Store active player positions in Redis.

Implement a 'ticker' that performs a batch UPSERT of player/mod data to the PostgreSQL database every 5 minutes.

Investigation: Look at the existing ./backend and ./compose structures to ensure networking (ports) and environment variables are consistent."