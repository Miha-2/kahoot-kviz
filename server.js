/* ═══════════════════════════════════════════════════════════
   KVIZ SERVER — Node.js WebSocket
   
   Zaženi:  npm install ws  &&  node server.js
   Odpri:   http://localhost:3000/master      (voditelj)
            http://localhost:3000/             (igralci)
   ═══════════════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Config ──
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'olimpija2025';

// ── Quiz questions — loaded from questions.json ──
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

function loadQuizConfig() {
    try {
        // Clear require cache so changes are picked up
        delete require.cache[require.resolve(QUESTIONS_FILE)];
        const data = require(QUESTIONS_FILE);
        console.log(`[Config] Loaded ${data.questions.length} questions from questions.json`);
        return data;
    } catch (e) {
        console.error('[Config] Failed to load questions.json:', e.message);
        return { timerSeconds: 15, questions: [] };
    }
}

let QUIZ_CONFIG = loadQuizConfig();

// ── Game state ──
let players = {};           // { id: { name, score, ws, answered, chosenIndex, answerTime, lastDelta } }
let masterWs = null;
let currentQ = 0;
let phase = 'lobby';        // lobby | question | timer_done | revealed | leaderboard | final
let questionStartTime = 0;
let timerHandle = null;

// ── HTTP server (serve static files) ──
const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
    // API endpoint: get config (for client to know question count)
    if (req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            questionCount: QUIZ_CONFIG.questions.length,
            timerSeconds: QUIZ_CONFIG.timerSeconds
        }));
        return;
    }

    // API endpoint: QR code as SVG
    if (req.url.startsWith('/api/qr')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const text = urlObj.searchParams.get('url') || `http://${req.headers.host}/`;
        try {
            const QRCode = require('qrcode');
            QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0a2e1a', light: '#ffffff' } }, (err, svg) => {
                if (err) {
                    res.writeHead(500);
                    res.end('QR generation failed');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end(svg);
            });
        } catch (e) {
            res.writeHead(500);
            res.end('QR module not available');
        }
        return;
    }

    // API endpoint: reset game via URL
    // Usage: /api/reset?key=YOUR_ADMIN_KEY
    if (req.url.startsWith('/api/reset')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const key = urlObj.searchParams.get('key');
        if (key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key' }));
            return;
        }
        resetGame();
        console.log('[Admin] Game reset via API');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Game reset. All players cleared.' }));
        return;
    }

    // Clean URL routing (no .html extensions)
    const urlPath = req.url.split('?')[0];
    const routes = {
        '/': '/client.html',
        '/client': '/client.html',
        '/master': '/master.html',
    };

    let filePath = routes[urlPath] || urlPath;
    // If no extension and not a known route, try .html
    if (!path.extname(filePath) && !routes[urlPath]) {
        filePath = filePath + '.html';
    }
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

// ── WebSocket server ──
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const role = url.searchParams.get('role');

    if (role === 'master') {
        masterWs = ws;
        console.log('[Master] connected');

        // Build full state snapshot for reconnect
        const q = QUIZ_CONFIG.questions[currentQ];
        const answeredCount = Object.values(players).filter(p => p.answered).length;
        const totalPlayers = Object.keys(players).length;

        const sorted = Object.entries(players)
            .map(([id, p]) => ({ id, name: p.name, score: p.score, lastDelta: p.lastDelta || 0 }))
            .sort((a, b) => b.score - a.score);

        ws.send(JSON.stringify({
            type: 'init',
            config: {
                questionCount: QUIZ_CONFIG.questions.length,
                timerSeconds: QUIZ_CONFIG.timerSeconds,
                questions: QUIZ_CONFIG.questions.map(q => ({
                    question: q.question,
                    options: q.options
                }))
            },
            players: Object.fromEntries(
                Object.entries(players).map(([id, p]) => [id, { name: p.name, score: p.score }])
            ),
            phase,
            currentQ,
            // Extra state for reconnect
            currentQuestion: q ? { index: currentQ, question: q.question, options: q.options, totalQuestions: QUIZ_CONFIG.questions.length, playerCount: totalPlayers } : null,
            correctIndex: (phase === 'revealed' || phase === 'leaderboard' || phase === 'final') ? q?.correctIndex : undefined,
            optionCounts: (phase !== 'lobby') ? getOptionCounts() : undefined,
            answeredCount,
            totalPlayers,
            rankings: sorted
        }));

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                handleMasterMessage(msg);
            } catch (e) { console.error('Master parse error:', e); }
        });

        ws.on('close', () => {
            console.log('[Master] disconnected');
            masterWs = null;
        });

    } else {
        // Client player
        let connPlayerId = null;

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);

                if (msg.type === 'join') {
                    connPlayerId = 'p_' + Math.random().toString(36).slice(2, 8);
                    players[connPlayerId] = {
                        name: msg.name,
                        score: 0,
                        ws,
                        answered: false,
                        chosenIndex: -1,
                        answerTime: 0,
                        lastDelta: 0
                    };
                    console.log(`[Player] ${msg.name} joined as ${connPlayerId}`);

                    // Ack to player
                    ws.send(JSON.stringify({ type: 'joined', playerId: connPlayerId, name: msg.name }));

                    // Notify master
                    sendToMaster({
                        type: 'player_joined',
                        playerId: connPlayerId,
                        name: msg.name,
                        playerCount: Object.keys(players).length
                    });

                    broadcastClients({ type: 'player_count', count: Object.keys(players).length });

                    // If game is already in progress, send current question
                    if (phase === 'question' || phase === 'timer_done') {
                        const q = QUIZ_CONFIG.questions[currentQ];
                        ws.send(JSON.stringify({
                            type: 'question',
                            index: currentQ,
                            question: q.question,
                            options: q.options,
                            timerSeconds: QUIZ_CONFIG.timerSeconds,
                            totalQuestions: QUIZ_CONFIG.questions.length
                        }));
                    }
                }

                if (msg.type === 'rejoin') {
                    const existingId = msg.playerId;
                    if (existingId && players[existingId]) {
                        // Reattach websocket to existing player
                        connPlayerId = existingId;
                        players[connPlayerId].ws = ws;
                        console.log(`[Player] ${players[connPlayerId].name} rejoined as ${connPlayerId}`);

                        const p = players[connPlayerId];

                        // Build current question data if in game
                        let currentQuestion = null;
                        let timeRemaining = null;
                        if ((phase === 'question' || phase === 'timer_done') && QUIZ_CONFIG.questions[currentQ]) {
                            const q = QUIZ_CONFIG.questions[currentQ];
                            currentQuestion = {
                                index: currentQ,
                                question: q.question,
                                options: q.options,
                                timerSeconds: QUIZ_CONFIG.timerSeconds,
                                totalQuestions: QUIZ_CONFIG.questions.length
                            };
                            // Calculate remaining time
                            const elapsed = (Date.now() - questionStartTime) / 1000;
                            timeRemaining = Math.max(0, QUIZ_CONFIG.timerSeconds - elapsed);
                        }

                        // Build reveal data if in revealed/leaderboard phase
                        let lastReveal = null;
                        if (phase === 'revealed' || phase === 'leaderboard') {
                            const q = QUIZ_CONFIG.questions[currentQ];
                            lastReveal = {
                                correctIndex: q.correctIndex,
                                yourChosenIndex: p.chosenIndex,
                                score: p.score,
                                lastDelta: p.lastDelta,
                                isCorrect: p.chosenIndex === q.correctIndex,
                                didAnswer: p.answered
                            };
                        }

                        // Build final data if in final
                        let finalData = null;
                        if (phase === 'final') {
                            const sorted = Object.entries(players)
                                .map(([id, pl]) => ({ id, name: pl.name, score: pl.score }))
                                .sort((a, b) => b.score - a.score);
                            const rank = sorted.findIndex(s => s.id === connPlayerId) + 1;
                            finalData = {
                                score: p.score,
                                rank,
                                totalPlayers: sorted.length,
                                topScore: sorted[0]?.score || 1
                            };
                        }

                        ws.send(JSON.stringify({
                            type: 'rejoined',
                            playerId: connPlayerId,
                            name: p.name,
                            score: p.score,
                            phase,
                            currentQuestion,
                            timeRemaining,
                            alreadyAnswered: p.answered,
                            lastReveal,
                            finalData
                        }));
                    } else {
                        // Player not found (server restarted?) — ask client to rejoin manually
                        console.log(`[Player] rejoin failed for ${msg.playerId}, asking to re-enter name`);
                        ws.send(JSON.stringify({ type: 'rejoin_failed' }));
                    }
                }

                if (msg.type === 'answer' && connPlayerId) {
                    handlePlayerAnswer(connPlayerId, msg);
                }

            } catch (e) { console.error('Client parse error:', e); }
        });

        ws.on('close', () => {
            if (connPlayerId && players[connPlayerId]) {
                console.log(`[Player] ${players[connPlayerId].name} disconnected`);
                // Don't remove — they might reconnect
                players[connPlayerId].ws = null;
            }
        });
    }
});

// ── Master commands ──
function handleMasterMessage(msg) {
    if (msg.type === 'start') {
        currentQ = 0;
        // Allow master to override timer
        if (msg.timerSeconds && msg.timerSeconds >= 5 && msg.timerSeconds <= 60) {
            QUIZ_CONFIG.timerSeconds = msg.timerSeconds;
        }
        // Reset scores
        Object.values(players).forEach(p => { p.score = 0; p.lastDelta = 0; });
        sendQuestion();
    }

    if (msg.type === 'reveal') {
        doReveal();
    }

    if (msg.type === 'leaderboard') {
        showLeaderboard();
    }

    if (msg.type === 'next') {
        currentQ++;
        if (currentQ < QUIZ_CONFIG.questions.length) {
            sendQuestion();
        } else {
            doFinal();
        }
    }

    if (msg.type === 'reset') {
        resetGame();
    }
}

// ── Send question ──
function sendQuestion() {
    const q = QUIZ_CONFIG.questions[currentQ];
    phase = 'question';
    questionStartTime = Date.now();

    // Reset answers
    Object.values(players).forEach(p => {
        p.answered = false;
        p.chosenIndex = -1;
        p.answerTime = 0;
    });

    // Send to master (with correctIndex for display after reveal)
    sendToMaster({
        type: 'question',
        index: currentQ,
        question: q.question,
        options: q.options,
        timerSeconds: QUIZ_CONFIG.timerSeconds,
        totalQuestions: QUIZ_CONFIG.questions.length,
        playerCount: Object.keys(players).length
    });

    // Send to clients (WITHOUT correctIndex!)
    broadcastClients({
        type: 'question',
        index: currentQ,
        question: q.question,
        options: q.options,
        timerSeconds: QUIZ_CONFIG.timerSeconds,
        totalQuestions: QUIZ_CONFIG.questions.length
    });

    // Server-side timer
    clearTimeout(timerHandle);
    timerHandle = setTimeout(() => {
        if (phase === 'question') {
            phase = 'timer_done';
            sendToMaster({ type: 'time_up' });
            broadcastClients({ type: 'time_up' });
        }
    }, QUIZ_CONFIG.timerSeconds * 1000);
}

// ── Handle player answer ──
function handlePlayerAnswer(playerId, msg) {
    if (phase !== 'question' && phase !== 'timer_done') return;
    const p = players[playerId];
    if (!p || p.answered) return;

    p.answered = true;
    p.chosenIndex = msg.chosenIndex;
    p.answerTime = Date.now() - questionStartTime;

    const answeredCount = Object.values(players).filter(pl => pl.answered).length;
    const totalPlayers = Object.keys(players).length;

    // Notify master of answer count
    sendToMaster({
        type: 'answer_update',
        answeredCount,
        totalPlayers,
        // Per-option counts
        optionCounts: getOptionCounts()
    });

    // All answered? Signal early finish
    if (answeredCount >= totalPlayers) {
        clearTimeout(timerHandle);
        phase = 'timer_done';
        sendToMaster({ type: 'all_answered' });
        broadcastClients({ type: 'time_up' });
    }
}

function getOptionCounts() {
    const q = QUIZ_CONFIG.questions[currentQ];
    return q.options.map((_, i) =>
        Object.values(players).filter(p => p.chosenIndex === i).length
    );
}

// ── Reveal ──
function doReveal() {
    phase = 'revealed';
    clearTimeout(timerHandle);
    const q = QUIZ_CONFIG.questions[currentQ];

    // Score players
    Object.values(players).forEach(p => {
        if (p.chosenIndex === q.correctIndex) {
            const timePct = Math.max(0, 1 - (p.answerTime / (QUIZ_CONFIG.timerSeconds * 1000)));
            p.lastDelta = Math.round(500 + timePct * 500);
            p.score += p.lastDelta;
        } else {
            p.lastDelta = 0;
        }
    });

    // Build player data for clients
    const playerData = {};
    Object.entries(players).forEach(([id, p]) => {
        playerData[id] = {
            score: p.score,
            lastDelta: p.lastDelta,
            chosenIndex: p.chosenIndex
        };
    });

    // Send to master
    sendToMaster({
        type: 'reveal',
        correctIndex: q.correctIndex,
        optionCounts: getOptionCounts(),
        players: playerData
    });

    // Send to each client (personalized)
    Object.entries(players).forEach(([id, p]) => {
        if (p.ws && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: 'reveal',
                correctIndex: q.correctIndex,
                yourChosenIndex: p.chosenIndex,
                score: p.score,
                lastDelta: p.lastDelta,
                isCorrect: p.chosenIndex === q.correctIndex,
                didAnswer: p.answered
            }));
        }
    });
}

// ── Leaderboard ──
function showLeaderboard() {
    phase = 'leaderboard';

    const sorted = Object.entries(players)
        .map(([id, p]) => ({ id, name: p.name, score: p.score, lastDelta: p.lastDelta }))
        .sort((a, b) => b.score - a.score);

    sendToMaster({ type: 'leaderboard', rankings: sorted });
    broadcastClients({ type: 'leaderboard' });
}

// ── Final ──
function doFinal() {
    phase = 'final';

    const sorted = Object.entries(players)
        .map(([id, p]) => ({ id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);

    sendToMaster({ type: 'final', rankings: sorted });

    // Send personalized final to each client
    Object.entries(players).forEach(([id, p]) => {
        const rank = sorted.findIndex(s => s.id === id) + 1;
        if (p.ws && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
                type: 'final',
                score: p.score,
                rank,
                totalPlayers: sorted.length,
                topScore: sorted[0]?.score || 1
            }));
        }
    });
}

// ── Reset ──
function resetGame() {
    phase = 'lobby';
    currentQ = 0;
    clearTimeout(timerHandle);
    // Notify clients before wiping
    broadcastClients({ type: 'reset' });
    // Wipe all players
    players = {};
    // Reload questions (pick up any changes to questions.json)
    QUIZ_CONFIG = loadQuizConfig();
    sendToMaster({ type: 'reset_ack', playerCount: 0 });
}

// ── Helpers ──
function sendToMaster(data) {
    if (masterWs && masterWs.readyState === 1) {
        masterWs.send(JSON.stringify(data));
    }
}

function broadcastClients(data) {
    const json = JSON.stringify(data);
    Object.values(players).forEach(p => {
        if (p.ws && p.ws.readyState === 1) {
            p.ws.send(json);
        }
    });
}

// ── Start ──
server.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   KVIZ SERVER                        ║`);
    console.log(`  ╠══════════════════════════════════════╣`);
    console.log(`  ║   Voditelj:  http://localhost:${PORT}/master`);
    console.log(`  ║   Igralci:   http://localhost:${PORT}/`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
});
