#!/bin/bash
# Starts both the Express API (port 3001) and Vite frontend (port 5173) together.
# Press Ctrl+C once to stop both.

trap "echo 'Stopping...'; kill 0" EXIT

echo "Installing server dependencies..."
(cd server && npm install --silent)

echo "Starting API server on :3001 ..."
(cd server && npm run dev) &

echo "Starting Vite on :5173 ..."
pnpm dev
