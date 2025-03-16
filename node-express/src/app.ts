// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import { config } from "dotenv";
import { pino } from "pino";
import { RTSession } from "./session.js";
import { JsonDataService } from "./json-data-service.js";
import path from "path";

config();

const logger = pino({
  level: process.env.LOG_LEVEL || "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

const app = express();
app.use(express.json());

// Initialize JsonDataService
const dataService = new JsonDataService(path.join(process.cwd(), 'data', 'sculptures.json'));
await dataService.loadData();

// REST endpoints for sculptures
app.get('/api/general/gallery', async (req, res) => {
  const galleryInfo = await dataService.getGalleryInfo();
  if (galleryInfo) {
    res.json(galleryInfo);
  } else {
    res.status(404).json({ error: 'Gallery information not found' });
  }
});

app.get('/api/general/gothic', async (req, res) => {
  const gothicInfo = await dataService.getGothicStyleInfo();
  if (gothicInfo) {
    res.json(gothicInfo);
  } else {
    res.status(404).json({ error: 'Gothic style information not found' });
  }
});

app.get('/api/sculptures', async (req, res) => {
  const { name, artist, location, year } = req.query;
  const sculptures = await dataService.searchSculptures({
    name: name?.toString(),
    artist: artist?.toString(),
    location: location?.toString(),
    year: year?.toString()
  });
  res.json(sculptures);
});

app.get('/api/sculptures/:name', async (req, res) => {
  const sculpture = await dataService.getSculptureByName(req.params.name);
  if (sculpture) {
    res.json(sculpture);
  } else {
    res.status(404).json({ error: 'Sculpture not found' });
  }
});

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url!, `http://${request.headers.host}`);
  if (pathname === "/realtime") {
    logger.debug({ pathname }, "Handling WebSocket upgrade request");
    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.debug("WebSocket upgrade successful");
      wss.emit("connection", ws, request);
    });
  } else {
    logger.warn({ pathname }, "Invalid WebSocket path - destroying connection");
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  logger.info("New WebSocket connection established");
  logger.info("BACKEND: " + process.env.BACKEND);
  new RTSession(ws, process.env.BACKEND, logger);
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  logger.info(`Server started on http://localhost:${PORT}`);
});
