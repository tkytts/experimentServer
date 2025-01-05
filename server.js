const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const config = require("./config.json");
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: config.server.cors,
});

const PORT = config.server.port;

// In-memory storage
let messages = [];
let confederateName = "";
let timer = null;
let maxTime = config.chat.maxTime;
let countdown = null;
let pointsAwarded = config.chat.pointsAwarded;
let currentScore = 0;
let currentBlockIndex = null;
let currentProblemIndex = null;
let gameIsLive = false;
let chimesConfig = null;
let gameResolutionType = null;
let teamAnswer = null;

// Load blocks from JSON file
let blocks = [];
try {
    const blocksData = fs.readFileSync(path.join(__dirname, "resources/blocks.json"), "utf-8");
    blocks = JSON.parse(blocksData);
} catch (err) {
    console.error("Error reading blocks.json:", err);
}

// Enable CORS
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Endpoint to fetch blocks
app.get("/blocks", (req, res) => {
    res.json(blocks);
});


// Socket.IO connection
io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Chat messages
    socket.on("chat message", (msg) => {
        messages.push(msg);
        io.emit("chat message", msg); // Broadcast to all clients
    });

    // User typing
    socket.on("typing", (username) => {
        socket.broadcast.emit("user typing", username); // Notify other users
    });

    // Clear chat
    socket.on("clear chat", () => {
        // Save messages to a text file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dirPath = path.join(__dirname);
        const filePath = path.join(dirPath, `chat_logs_${timestamp}.txt`);
        const fileContent = `Chat Log - ${timestamp}\n\n` + messages.map(m => `${m.timeStamp} - ${m.user}: ${m.text}`).join("\n") + "\n\n";

        // Ensure the directory exists
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFile(filePath, fileContent, (err) => {
            if (err) {
                console.error("Error saving chat log:", err);
            } else {
                console.log("Chat log saved successfully.");
            }
        });

        // Clear the chat messages
        messages = [];
        io.emit("chat cleared");
    });

    // Set confederate
    socket.on("set confederate", (name) => {
        confederateName = name;
        io.emit("new confederate", confederateName);
    });

    // Update problem selection
    socket.on("update problem selection", ({ blockIndex, problemIndex }) => {
        currentBlockIndex = blockIndex;
        currentProblemIndex = problemIndex;

        refreshGameItems();
    });

    socket.on("first block", () => {
        currentBlockIndex = 0;
        currentProblemIndex = 0;

        refreshGameItems();
    })

    socket.on("next block", () => {
        if (currentBlockIndex >= 0)
            currentBlockIndex++;
        else
            currentBlockIndex = 0;

        currentProblemIndex = 0;

        refreshGameItems();
    })

    socket.on("next problem", () => {
        if (currentProblemIndex)
            currentProblemIndex = currentProblemIndex++;
        else
            currentProblemIndex = 0;

        refreshGameItems();
    })

    // Timer controls
    socket.on("start timer", () => {
        countdown = maxTime;

        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            if (countdown > 0) {
                countdown -= 1;
                io.emit("timer update", countdown);
            } else {
                clearInterval(timer);
                resolveGame();
                timer = null;
            }
        }, 1000);
    });

    socket.on("stop timer", () => {
        if (timer)
            clearInterval(timer);
        timer = null;
    });

    socket.on("reset timer", () => {
        countdown = maxTime;
        io.emit("timer update", countdown);
    });

    socket.on("set max time", (time) => {
        maxTime = time;

        if (timer)
            clearInterval(timer);

        timer = null;
        io.emit("timer update", maxTime);

        console.log("Max time set to:", time);
    });

    socket.on("telemetry event", async (data) => {
        await saveTelemetryData(data);
    });

    socket.on("start game", async () => {
        gameIsLive = true;
        io.emit("status update", gameIsLive);
        console.log("Game is live");
    });

    socket.on("stop game", async () => {
        gameIsLive = false;
        io.emit("status update", gameIsLive);
        console.log("Game is not live");
    });

    socket.on("set chimes", async (data) => {
        chimesConfig = data;
        io.emit("chimes updated", chimesConfig);
    });

    socket.on("get chimes", async () => {
        io.emit("chimes updated", chimesConfig);
        console.log(`Chimes config propagated Message Sent: ${chimesConfig?.messageSent}, Message Received: ${chimesConfig?.messageReceived}, Timer: ${chimesConfig?.timer}`);
    })

    socket.on("set game resolution", async (data) => {
        gameResolutionType = data.gameResolutionType;
        teamAnswer = data.teamAnswer;
        io.emit("set answer", teamAnswer);
    });

    socket.on("disconnect", () => {
        console.log("A user disconnected:", socket.id);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

function refreshGameItems() {
    const block = blocks[currentBlockIndex];
    const problem = block.problems[currentProblemIndex];
    io.emit("problem update", { block, problem });
}

function resolveGame() {
    let correctAnswer = false;
    let telemetryData = {
        user,
        confederate,
        action: 'game resolved',
        text: null,
        timestamp: new Date().toISOString(),
        x: null,
        y: null,
        resolution: gameResolutionType,
    }

    let resolution;

    switch (gameResolutionType) {
        case 'AP', 'DP':
            currentScore += pointsAwarded;
            correctAnswer = true;
            resolution.pointsAwarded = pointsAwarded;
            break;
        case 'ANP', 'DNP':
            resolution.pointsAwarded = 0;
            break;
        case 'TNP':
            resolution.pointsAwarded = 0;
            teamAnswer = null;
            break;
        default:
            console.log('Unknown game type');
            break;
    }

    resolution.correctAnswer = correctAnswer;
    resolution.teamAnswer = teamAnswer;
    resolution.currentScore = currentScore;

    saveTelemetryData(telemetryData);
    io.emit("game resolved", resolution);
}

// Function to save data
const saveTelemetryData = async (data) => {
    // Check if the file exists
    let filePath = path.join(__dirname, `telemetry_data_${data.user}_${new Date().toISOString().split('T')[0]}.csv`);
    let fileExists = fs.existsSync(filePath);

    let csvWriter = createCsvWriter({
        path: filePath,
        header: [
            { id: 'user', title: 'USER' },
            { id: 'confederate', title: 'CONFEDERATE' },
            { id: 'action', title: 'ACTION' },
            { id: 'text', title: 'TEXT' },
            { id: 'timestamp', title: 'TIMESTAMP' },
            { id: 'x', title: 'X' },
            { id: 'y', title: 'Y' },
            { id: 'resolution', title: 'RESOLUTION' },
        ],
        append: fileExists, // Append to existing file if it exists
    });

    try {
        await csvWriter.writeRecords([data]); // Write as an array of objects
        console.log('Telemetry data saved to CSV');
    } catch (err) {
        console.error('Error saving telemetry data to CSV:', err);
    }
};