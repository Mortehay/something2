Existing Environment:

./backend: Node.js/Express (handling DB schema, Auth, and Game logic).

./frontend: 2D Game client (JS/Canvas or Phaser).

./compose: Contains docker-compose.yml for Postgres, Redis, and app services.

./engine: (New) Go-based WebSocket server.

Integration Logic:
The Game Client connects to the Go Engine via wss://. The Go Engine validates the user's JWT (issued by the Node.js backend). Once authenticated, the Go Engine manages the 2D world state in RAM and flushes to the shared Postgres DB every 30 minutes.

The game is a 2D sandbox MMO game. The world is tiled and entities are placed on the tiles. The world is generated using a Wave Function Collapse algorithm. The game is played in real-time and players can interact with each other.