# Worm Arena

Authoritative multiplayer server (Node, Express, Socket.io) plus the mobile-friendly game client in `public/`.
MongoDB is optional and only stores the leaderboard; live game state stays in server memory.

## Run locally
    npm install
    npm start          # http://localhost:3000
Optional: set MONGODB_URI (see .env.example) to enable the leaderboard.

## MongoDB Atlas
1. Create a free M0 cluster, then a database user (username + password).
2. Network Access: add 0.0.0.0/0 (Render free instances have no fixed IP).
3. Connect > Drivers: copy the connection string and put your password in it.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. New > Web Service > pick the repo. Runtime: Node.
3. Build command: `npm install`   Start command: `npm start`
4. Environment: add MONGODB_URI (and optionally DB_NAME).
5. Advanced: Health Check Path `/healthz`. Keep the instance count at 1 (game state is in memory).
6. Deploy, then open the onrender.com URL on your phone.

Notes: free instances sleep when idle (first load can take about a minute). WebSockets work on Render by default.

## Tuning (top of server.js)
MAX_PLAYERS, MAX_ROOMS, BOTS_PUBLIC, MAXFOOD, TICK.
