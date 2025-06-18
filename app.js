require("dotenv").config();
const express = require("express");
const expressWS = require("express-ws");
const fs = require("fs").promises;
const path = require("path");

const app = express();
expressWS(app);

const PORT = process.env.PORT || 3000;

// Step 1: Setup endpoint to return WebSocket URL
app.get("/setup", async (req, res) => {
  try {
    const { callsid, from, to } = req.query;

    if (!callsid || !from || !to) {
      return res.status(400).json({ error: "Missing required parameters: callsid, from, to" });
    }

    const dataDir = path.join(__dirname, "data");
    const filepath = path.join(dataDir, `${callsid}.json`);

    await fs.mkdir(dataDir, { recursive: true });

    let jsonData = {};

    // Read existing file or create new one
    try {
      const fileContent = await fs.readFile(filepath, "utf8");
      jsonData = JSON.parse(fileContent);
    } catch (err) {
      await fs.writeFile(filepath, JSON.stringify({}, null, 2), "utf8");
    }

    // Respond with WebSocket URL
    const webURL = `wss://${process.env.BASE_URL || "localhost:3000"}/connect?callsid=${callsid}`;
    return res.status(200).json({ websocket: webURL });

  } catch (error) {
    console.error("Setup error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Step 2: WebSocket route to handle bot communication
app.ws("/connect", async (ws, req) => {
  try {
    const url = new URL(`http://localhost${req.url}`);
    const callsid = url.searchParams.get("callsid");

    if (!callsid) {
      ws.close(4000, "Missing CallSid");
      return;
    }

    const audioDir = path.join(__dirname, "audio_data");
    const audioFilePath = path.join(audioDir, `${callsid}.raw`);

    await fs.mkdir(audioDir, { recursive: true });

    const writeStream = fs.createWriteStream(audioFilePath, { encoding: "base64" });

    ws.on("message", async (message) => {
      try {
        const payload = JSON.parse(message.toString());

        switch (payload.event) {
          case "start":
            console.log(`[Start] Audio stream started for ${callsid}`);
            break;

          case "media":
            const { chunk, payload: audioChunk } = payload.media;
            console.log(`Received chunk #${chunk} for call ${callsid}`);
            writeStream.write(audioChunk); // Write base64 chunk directly
            break;

          case "stop":
            console.log(`[Stop] Audio stream ended for ${callsid}`);
            writeStream.end();
            ws.close();
            break;

          default:
            console.log(`Unknown event: ${payload.event}`);
        }
      } catch (parseError) {
        console.error("Error parsing message:", parseError);
      }
    });

    ws.on("close", () => {
      console.log(`WebSocket closed for CallSid: ${callsid}`);
      writeStream.end();
    });

  } catch (error) {
    console.error("WebSocket connection error:", error);
    ws.close();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});