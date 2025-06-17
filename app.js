const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const url = require("url");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

// In-memory storage for call data (replace with database in production)
const callStorage = new Map();
const activeConnections = new Map();
const tokenStorage = new Map();

// Create Express app
const app = express();
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server with dynamic path support
const wss = new WebSocket.Server({ server, path: "/connection" });

// Rate limiter for HTTP endpoints
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});
app.use("/sampark", limiter);
app.use("/call-summary", limiter);

// Utility function to generate WebSocket endpoint
function generateWebSocketEndpoint(callSid) {
  const token = crypto.randomBytes(16).toString("hex");
  tokenStorage.set(token, callSid); // Store token for validation
  return `wss://${process.env.HOST || "localhost"}:${
    process.env.PORT || 3000
  }/connection?token=${token}&callSid=${callSid}`;
}

// 1. Initial API - GET endpoint
app.get("/sampark", (req, res) => {
  try {
    const { CallSid, From, To } = req.query;

    // Validate required parameters
    if (!CallSid || !From || !To) {
      return res.status(400).json({
        error: "Missing required parameters: CallSid, From, To",
      });
    }

    // Store initial call data
    const callData = {
      callSid: CallSid,
      from: From,
      to: To,
      startTime: new Date().toISOString(),
      status: "initiated",
      events: [],
      audioChunks: [],
    };

    callStorage.set(CallSid, callData);

    // Generate WebSocket endpoint
    const wsEndpoint = generateWebSocketEndpoint(CallSid);

    console.log(`[${new Date().toISOString()}] New call initiated:`, {
      CallSid,
      From,
      To,
      wsEndpoint,
    });

    // Return WebSocket endpoint
    res.json({
      websocket_url: wsEndpoint,
    });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in /sampark endpoint:`,
      error
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Post-call summary API - POST endpoint
app.post("/call-summary", (req, res) => {
  try {
    const { CallSid } = req.body;

    if (!CallSid) {
      return res.status(400).json({
        error: "Missing required parameter: CallSid",
      });
    }

    const callData = callStorage.get(CallSid);

    if (!callData) {
      return res.status(404).json({
        error: "Call data not found",
      });
    }

    // Generate call summary
    const summary = {
      call_sid: CallSid,
      from: callData.from,
      to: callData.to,
      start_time: callData.startTime,
      end_time: callData.endTime || new Date().toISOString(),
      duration: callData.duration || 0,
      total_events: callData.events.length,
      audio_chunks_received: callData.audioChunks.length,
      final_status: callData.status,
      events_summary: callData.events.map((event) => ({
        event: event.event,
        timestamp: event.timestamp,
        sequence_number: event.sequence_number,
        payload: event.payload, // Include full event payload
      })),
    };

    console.log(
      `[${new Date().toISOString()}] Call summary requested for CallSid: ${CallSid}`
    );

    res.json({
      status: "success",
      summary: summary,
    });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error in /call-summary endpoint:`,
      error
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// WebSocket connection handling
wss.on("connection", (ws, req) => {
  const queryParams = url.parse(req.url, true).query;
  const { callSid, token } = queryParams;

  // Validate token and callSid
  if (!callSid || !token || tokenStorage.get(token) !== callSid) {
    ws.close(1008, "Invalid callSid or token");
    console.error(
      `[${new Date().toISOString()}] WebSocket connection rejected: Invalid callSid or token`
    );
    return;
  }

  // Clean up token after successful connection
  tokenStorage.delete(token);

  // Store active connection
  activeConnections.set(callSid, ws);

  console.log(
    `[${new Date().toISOString()}] WebSocket connected for CallSid: ${callSid}`
  );

  // Update call status
  const callData = callStorage.get(callSid);
  if (callData) {
    callData.status = "connected";
    callData.wsConnectedTime = new Date().toISOString();
  }

  // Handle incoming WebSocket messages
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleWebSocketEvent(callSid, message, ws);
    } catch (error) {
      console.error(`[${callSid}] Error parsing WebSocket message:`, error);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message?.sequence_number
            ? message.sequence_number + 1
            : 0,
          stream_sid: callSid,
          error: "Invalid JSON format",
        })
      );
    }
  });

  // Handle WebSocket close
  ws.on("close", (code, reason) => {
    console.log(
      `[${new Date().toISOString()}] WebSocket closed for CallSid: ${callSid}, Code: ${code}, Reason: ${reason}`
    );

    // Remove from active connections
    activeConnections.delete(callSid);

    // Update call data
    const callData = callStorage.get(callSid);
    if (callData) {
      callData.status = "disconnected";
      callData.endTime = new Date().toISOString();
      if (callData.startTime) {
        const startTime = new Date(callData.startTime);
        const endTime = new Date(callData.endTime);
        callData.duration = Math.round((endTime - startTime) / 1000); // duration in seconds
      }
    }
  });

  // Handle WebSocket errors
  ws.on("error", (error) => {
    console.error(`[${callSid}] WebSocket error:`, error);
  });
});

// Handle different WebSocket events
function handleWebSocketEvent(callSid, message, ws) {
  const callData = callStorage.get(callSid);

  if (!callData) {
    console.error(
      `[${callSid}] Call data not found for event: ${message.event}`
    );
    ws.send(
      JSON.stringify({
        event: "error",
        sequence_number: message.sequence_number + 1,
        stream_sid: callSid,
        error: "Call data not found",
      })
    );
    return;
  }

  // Store the event with full payload
  callData.events.push({
    event: message.event,
    sequence_number: message.sequence_number,
    stream_sid: message.stream_sid,
    timestamp: new Date().toISOString(),
    payload: { ...message }, // Store full payload
  });

  console.log(
    `[${new Date().toISOString()}] [${callSid}] Received event: ${
      message.event
    }, Sequence: ${message.sequence_number}`
  );

  switch (message.event) {
    case "start":
      handleStartEvent(callSid, message, ws);
      break;

    case "media":
      handleMediaEvent(callSid, message, ws);
      break;

    case "stop":
      handleStopEvent(callSid, message, ws);
      break;

    case "xfer":
      handleXferEvent(callSid, message, ws);
      break;

    default:
      console.warn(`[${callSid}] Unknown event type: ${message.event}`);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: `Unknown event type: ${message.event}`,
        })
      );
  }
}

// Handle 'start' event
function handleStartEvent(callSid, message, ws) {
  const callData = callStorage.get(callSid);

  if (callData) {
    // Validate start payload
    if (
      !message.start ||
      !message.start.stream_sid ||
      !message.start.call_sid ||
      !message.start.account_sid ||
      !message.start.from ||
      !message.start.to ||
      !message.start.media_format ||
      !message.start.media_format.encoding ||
      !message.start.media_format.sample_rate ||
      !message.start.media_format.bit_rate
    ) {
      console.error(`[${callSid}] Invalid start event payload`);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: "Invalid start payload",
        })
      );
      return;
    }

    callData.status = "started";
    callData.mediaFormat = message.start.media_format;
    upperCase: message.start.call_sid; // Update callSid if different
    callData.accountSid = message.start.account_sid; // Store accountSid
    callData.from = message.start.from; // Update from
    callData.to = message.start.to; // Update to

    console.log(
      `[${callSid}] Call started with media format:`,
      message.start.media_format
    );

    // Send acknowledgment with consistent payload structure
    const response = {
      event: "start",
      sequence_number: message.sequence_number + 1,
      stream_sid: message.stream_sid,
      start: {
        stream_sid: message.start.stream_sid,
        call_sid: message.start.call_sid,
        account_sid: message.start.account_sid,
        from: message.start.from,
        to: message.start.to,
        custom_parameters: message.start.custom_parameters || {},
        media_format: message.start.media_format,
      },
    };

    ws.send(JSON.stringify(response));
  }
}

// Handle 'media' event
function handleMediaEvent(callSid, message, ws) {
  const callData = callStorage.get(callSid);

  if (callData) {
    // Validate media format
    if (
      !message.media ||
      !message.media.payload ||
      !message.media.chunk ||
      !message.media.timestamp
    ) {
      console.error(`[${callSid}] Invalid media event payload`);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: "Invalid media payload",
        })
      );
      return;
    }

    // Store audio chunk information
    const audioChunk = {
      chunk: message.media.chunk,
      timestamp: message.media.timestamp,
      payloadSize: message.media.payload.length,
      receivedAt: new Date().toISOString(),
    };

    callData.audioChunks.push(audioChunk);

    // Log every 100th chunk to avoid spam
    if (message.media.chunk % 100 === 0) {
      console.log(
        `[${callSid}] Received audio chunk ${message.media.chunk}, Total chunks: ${callData.audioChunks.length}`
      );
    }

    //audio processing
    try {
      const audioData = Buffer.from(message.media.payload, "base64");

      // Example: Echo back the audio for testing (remove in production)
      const echoResponse = {
        event: "media",
        sequence_number: message.sequence_number + 1000,
        stream_sid: callSid,
        media: {
          chunk: message.media.chunk,
          timestamp: Date.now().toString(),
          payload: message.media.payload, // Echo back for testing
        },
      };

      ws.send(JSON.stringify(echoResponse));
    } catch (error) {
      console.error(`[${callSid}] Error processing audio chunk:`, error);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: "Failed to process audio chunk",
        })
      );
    }
  }
}

// Handle 'stop' event
function handleStopEvent(callSid, message, ws) {
  const callData = callStorage.get(callSid);

  if (callData) {
    // Validate stop payload
    if (
      !message.stop ||
      !message.stop.call_sid ||
      !message.stop.account_sid ||
      !message.stop.reason
    ) {
      console.error(`[${callSid}] Invalid stop event payload`);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: "Invalid stop payload",
        })
      );
      return;
    }

    callData.status = "stopped";
    callData.stopReason = message.stop.reason;
    callData.callSid = message.stop.call_sid; // Update callSid if different
    callData.accountSid = message.stop.account_sid; // Store accountSid
    callData.endTime = new Date().toISOString();

    console.log(`[${callSid}] Call stopped. Reason: ${message.stop.reason}`);

    // Send acknowledgment with consistent payload structure
    const response = {
      event: "stop",
      sequence_number: message.sequence_number + 1,
      stream_sid: message.stream_sid,
      stop: {
        call_sid: message.stop.call_sid,
        account_sid: message.stop.account_sid,
        reason: message.stop.reason,
      },
    };

    ws.send(JSON.stringify(response));

    // Close WebSocket connection after a brief delay
    setTimeout(() => {
      ws.close(1000, "Call ended");
    }, 1000);
  }
}

// Handle 'xfer' event
function handleXferEvent(callSid, message, ws) {
  const callData = callStorage.get(callSid);

  if (callData) {
    // Validate xfer payload
    if (
      !message.xfer ||
      !message.xfer.call_sid ||
      !message.xfer.account_sid ||
      !message.xfer.reason
    ) {
      console.error(`[${callSid}] Invalid xfer event payload`);
      ws.send(
        JSON.stringify({
          event: "error",
          sequence_number: message.sequence_number + 1,
          stream_sid: callSid,
          error: "Invalid xfer payload",
        })
      );
      return;
    }

    callData.status = "transferred";
    callData.transferReason = message.xfer.reason;
    callData.callSid = message.xfer.call_sid;
    callData.accountSid = message.xfer.account_sid;
    callData.endTime = new Date().toISOString();

    console.log(
      `[${callSid}] Call transferred. Reason: ${message.xfer.reason}, CallSid: ${message.xfer.call_sid}, AccountSid: ${message.xfer.account_sid}`
    );

    // Send acknowledgment with consistent payload structure
    const response = {
      event: "xfer",
      sequence_number: message.sequence_number + 1,
      stream_sid: message.stream_sid,
      xfer: {
        call_sid: message.xfer.call_sid,
        account_sid: message.xfer.account_sid,
        reason: message.xfer.reason,
      },
    };

    ws.send(JSON.stringify(response));

    // Close WebSocket connection after a brief delay
    setTimeout(() => {
      ws.close(1000, "Call transferred");
    }, 1000);
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    active_calls: activeConnections.size,
    total_calls: callStorage.size,
  });
});

// Get call details endpoint (for debugging)
app.get("/call/:callSid", (req, res) => {
  const { callSid } = req.params;
  const callData = callStorage.get(callSid);

  if (!callData) {
    return res.status(404).json({ error: "Call not found" });
  }

  // Return call data without sensitive information
  const sanitizedData = {
    ...callData,
    audioChunks: `${callData.audioChunks.length} chunks received`,
    events: callData.events.map((event) => ({
      event: event.event,
      sequence_number: event.sequence_number,
      stream_sid: event.stream_sid,
      timestamp: event.timestamp,
      payload: event.payload,
    })),
  };

  res.json(sanitizedData);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BOT FLOW Server running on port ${PORT}`);
  console.log(`HTTP API: http://localhost:${PORT}/sampark`);
  console.log(`WebSocket: ws://localhost:${PORT}/connection`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = { app, server, wss };
