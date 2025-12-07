/**
 * Express server setup with Socket.IO for real-time communication.
 * 
 * @module server
 */

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
    path: '/api/socket.io'
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
let participantName = null;
let logPath = __dirname + "/logs";

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

/**
 * Endpoint to fetch blocks.
 * @name /api/blocks
 * @function
 * @memberof module:server
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
app.get("/api/blocks", (req, res) => {
    res.json(blocks);
});

app.get("/api/currentUser", (req, res) => {
    res.json(participantName);
});

// Socket.IO connection
io.on("connection", (socket) => {
    /**
     * Set participant name.
     * @event set participantName
     * @param {string} name - Participant name.
     */
    socket.on("set participantName", (name) => {
        console.log("A user connected:", name);
        participantName = name;
    });

    /**
     * Handle chat messages.
     * @event chat message
     * @param {Object} msg - Chat message object.
     */
    socket.on("chat message", (msg) => {
        messages.push(msg);
        io.emit("chat message", msg); // Broadcast to all clients
    });

    /**
     * Handle user typing event.
     * @event typing
     * @param {string} username - Username of the person typing.
     */
    socket.on("typing", (username) => {
        socket.broadcast.emit("user typing", username); // Notify other users
    });

    /**
     * Clear chat messages and save to a text file.
     * @event clear chat
     */
    socket.on("clear chat", () => {
        const chatLogContent = messages.map(m => `${m.timeStamp} - ${m.user}: ${m.text}`).join("\n");
        createLogFile("chat_logs", chatLogContent);

        // Clear the chat messages
        messages = [];
        io.emit("chat cleared");
    });

    // Function to create log files
    function createLogFile(fileNamePrefix, data) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dirPath = path.join(logPath);
        const filePath = path.join(dirPath, `${fileNamePrefix}_${timestamp}.txt`);
        const fileContent = `Log - ${timestamp}\n\n${data}\n\n`;

        // Ensure the directory exists
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFile(filePath, fileContent, (err) => {
            if (err) {
                console.error(`Error saving ${fileNamePrefix} log:`, err);
            } else {
                console.log(`${fileNamePrefix} log saved successfully.`);
            }
        });
    }

    /**
     * Set confederate name.
     * @event set confederate
     * @param {string} name - Confederate name.
     */
    socket.on("set confederate", (name) => {
        confederateName = name;
        io.emit("new confederate", confederateName);
    });

    /**
     * Update problem selection.
     * @event update problem selection
     * @param {Object} selection - Problem selection object.
     * @param {number} selection.blockIndex - Block index.
     * @param {number} selection.problemIndex - Problem index.
     */
    socket.on("update problem selection", ({ blockIndex, problemIndex }) => {
        currentBlockIndex = blockIndex;
        currentProblemIndex = problemIndex;

        refreshGameItems();
    });

    /**
     * Select the first block.
     * @event first block
     */
    socket.on("first block", () => {
        currentBlockIndex = 0;
        currentProblemIndex = 0;

        refreshGameItems();
    });

    /**
     * Select the next block.
     * @event next block
     */
    socket.on("next block", () => {
        if (currentBlockIndex >= 0)
            currentBlockIndex++;
        else
            currentBlockIndex = 0;

        currentProblemIndex = 0;

        refreshGameItems();
    });

    /**
     * Select the next problem.
     * @event next problem
     */
    socket.on("next problem", () => {
        saveTelemetryData({
            user: participantName,
            confederate: confederateName,
            action: 'next problem',
            text: null,
            timestamp: new Date().toISOString()
        });

        if (currentProblemIndex != null && currentProblemIndex < 4)
            currentProblemIndex++;
        else
            currentProblemIndex = 0;

        refreshGameItems();
    });

    /**
     * Start the timer.
     * @event start timer
     */
    socket.on("start timer", () => {
        countdown = maxTime;

        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            if (countdown > 0) {
                countdown -= 1;
                io.emit("timer update", countdown);
            } else {
                clearInterval(timer);
                gameResolutionType = "TNP";
                resolveGame();
                timer = null;
            }
        }, 1000);
    });

    /**
     * Stop the timer.
     * @event stop timer
     */
    socket.on("stop timer", () => {
        if (timer)
            clearInterval(timer);
        timer = null;
    });

    /**
     * Reset the timer.
     * @event reset timer
     */
    socket.on("reset timer", () => {
        countdown = maxTime;
        io.emit("timer update", countdown);
    });

    /**
     * Set the maximum time for the timer.
     * @event set max time
     * @param {number} time - Maximum time in seconds.
     */
    socket.on("set max time", (time) => {
        maxTime = time;

        if (timer)
            clearInterval(timer);

        timer = null;
        io.emit("timer update", maxTime);

        console.log("Max time set to:", time);
    });

    /**
     * Save telemetry event data.
     * @event telemetry event
     * @param {Object} data - Telemetry data object.
     */
    socket.on("telemetry event", async (data) => {
        await saveTelemetryData(data);
    });

    /**
     * Start the game.
     * @event start game
     */
    socket.on("start game", async () => {
        gameIsLive = true;
        io.emit("status update", gameIsLive);
        console.log("Game is live");
    });

    /**
     * Stop the game.
     * @event stop game
     */
    socket.on("stop game", async () => {
        gameIsLive = false;
        io.emit("status update", gameIsLive);
        console.log("Game is not live");
    });

    /**
     * Set chimes configuration.
     * @event set chimes
     * @param {Object} data - Chimes configuration data.
     */
    socket.on("set chimes", async (data) => {
        chimesConfig = data;
        io.emit("chimes updated", chimesConfig);
    });

    /**
     * Get chimes configuration.
     * @event get chimes
     */
    socket.on("get chimes", async () => {
        io.emit("chimes updated", chimesConfig);
        console.log(`Chimes config propagated Message Sent: ${chimesConfig?.messageSent}, Message Received: ${chimesConfig?.messageReceived}, Timer: ${chimesConfig?.timer}`);
    });

    /**
     * Set game resolution type and team answer.
     * @event set game resolution
     * @param {Object} data - Game resolution data.
     * @param {string} data.gameResolutionType - Game resolution type.
     * @param {string} data.teamAnswer - Team answer.
     */
    socket.on("set game resolution", async (data) => {
        gameResolutionType = data.gameResolutionType;
        teamAnswer = data.teamAnswer;
        io.emit("set answer", teamAnswer);
    });

    socket.on("block finished", async () => {
        io.emit("new confederate", "");
    });

    socket.on("tutorial problem", async (data) => {
        io.emit("problem update", data);
    });

    socket.on("reset points", async () => {
        currentScore = 0;
        io.emit("points update", currentScore);
    });

    /**
     * Handle user disconnection.
     * @event disconnect
     */
    socket.on("disconnect", () => {
        console.log("A user disconnected:", socket.id);
    });

    socket.on("clear answer", () => {
        io.emit("set answer", "");
    });

    socket.on("tutorial done", (numTries) => {
        const tutorialLogContent = `Timestamp: ${new Date().toISOString()} - Tries: ${numTries}\n\n`;
        createLogFile("tutorial_logs", tutorialLogContent);
        io.emit("tutorial done", numTries);
    });

    socket.on("game ended", () => {
        io.emit("show end modal", "");
    });
});

/**
 * Start the server.
 * @function
 * @memberof module:server
 */
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

/**
 * Refresh game items and emit problem update.
 * @function
 * @memberof module:server
 */
function refreshGameItems() {
    const block = blocks[currentBlockIndex];
    const problem = block?.problems[currentProblemIndex];
    io.emit("problem update", { block, problem });
}

/**
 * Resolve the game and emit game resolution.
 * @function
 * @memberof module:server
 */
function resolveGame() {
    let isAnswerCorrect = false;
    let telemetryData = {
        user: participantName,
        confederate: confederateName,
        action: 'game resolved',
        text: null,
        timestamp: new Date().toISOString(),
        x: null,
        y: null,
        resolution: gameResolutionType,
    }

    let resolution = {};

    switch (gameResolutionType) {
        case 'AP':
        case 'DP':
            currentScore += pointsAwarded;
            isAnswerCorrect = true;
            resolution.pointsAwarded = pointsAwarded;
            break;
        case 'ANP':
        case 'DNP':
            resolution.pointsAwarded = 0;
            break;
        default:
        case 'TNP':
            resolution.pointsAwarded = 0;
            teamAnswer = null;
            break;
    }

    resolution.isAnswerCorrect = isAnswerCorrect;
    resolution.teamAnswer = teamAnswer;
    resolution.currentScore = currentScore;

    saveTelemetryData(telemetryData);
    gameResolutionType = null;
    teamAnswer = null;
    io.emit("game resolved", resolution);
}

/**
 * Save telemetry data to a CSV file.
 * @function
 * @memberof module:server
 * @param {Object} data - Telemetry data object.
 * @param {string} data.user - User name.
 * @param {string} data.confederate - Confederate name.
 * @param {string} data.action - Action performed.
 * @param {string} data.text - Text data.
 * @param {string} data.timestamp - Timestamp of the event.
 * @param {number} data.x - X coordinate.
 * @param {number} data.y - Y coordinate.
 * @param {string} data.resolution - Resolution type.
 */
const saveTelemetryData = async (data) => {
    let isConfederateMessage = data.action == "CONFEDERATE MESSAGE";
    let user = isConfederateMessage ? data.confederate : data.user;

    // Check if the file exists
    let filePath = path.join(logPath, `telemetry_data_${user}_${new Date().toISOString().split('T')[0]}.csv`);
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