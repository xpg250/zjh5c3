const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== 扑克牌逻辑 ====================

const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
// 【修改1】新增 MIXED_235 牌型，等级最低
const HAND_TYPES = { MIXED_235:0, SINGLE:1, PAIR:2, STRAIGHT:3, FLUSH:4, STRAIGHT_FLUSH:5, THREE_OF_KIND:6 };
function valueName(v) { return {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'}[v]; }

function createDeck() {
    const deck = [];
    for (const suit of ['♠','♥','♣','♦'])
        for (const rank of ['2','3','4','5','6','7','8','9','10','J','Q','K','A'])
            deck.push({ suit, rank, value: RANK_VALUES[rank] });
    return deck;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// 【修改2】evaluateHand：新增杂色235检测 + A23标记
function evaluateHand(cards) {
    const values = cards.map(c => c.value).sort((a, b) => a - b);
    const suits = cards.map(c => c.suit);
    const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
    const isThree = values[0] === values[1] && values[1] === values[2];
    const isStraight = (values[1] === values[0]+1 && values[2] === values[1]+1) ||
                       (values[0]===2 && values[1]===3 && values[2]===14);

    // 豹子
    if (isThree) return { type: HAND_TYPES.THREE_OF_KIND, values, desc: '豹子' + valueName(values[0]) };

    // 顺金
    if (isStraight && isFlush) return { type: HAND_TYPES.STRAIGHT_FLUSH, values, desc: '顺金' + valueName(values[2]) };

    // 顺子（A23标记为最小顺子）
    if (isStraight) {
        const isA23 = (values[0]===2 && values[1]===3 && values[2]===14);
        return {
            type: HAND_TYPES.STRAIGHT,
            values,
            desc: isA23 ? '顺子A23（最小）' : '顺子' + valueName(values[2]),
            lowStraight: isA23  // 标记A23为最小顺子
        };
    }

    // 金花
    if (isFlush) return { type: HAND_TYPES.FLUSH, values, desc: '金花' + valueName(values[2]) };

    // 【新增】杂色235（花色不全相同，点数为2、3、5）
    const sortedRanks = cards.map(c => c.rank).sort();
    const suitsSet = new Set(suits);
    if (sortedRanks[0]==='2' && sortedRanks[1]==='3' && sortedRanks[2]==='5' && suitsSet.size > 1) {
        return { type: HAND_TYPES.MIXED_235, values, desc: '杂色235' };
    }

    // 对子
    let pairValue = 0, kicker = 0;
    if (values[0] === values[1]) { pairValue = values[0]; kicker = values[2]; }
    else if (values[1] === values[2]) { pairValue = values[1]; kicker = values[0]; }
    else if (values[0] === values[2]) { pairValue = values[0]; kicker = values[1]; }
    if (pairValue) return { type: HAND_TYPES.PAIR, values, pairValue, kicker, desc: '对' + valueName(pairValue) };

    // 单张
    return { type: HAND_TYPES.SINGLE, values, desc: '单张' + valueName(values[2]) };
}

// 【修改3】compareHands：处理杂色235 vs 豹子 + A23最小顺子
function compareHands(h1, h2) {
    // ===== 杂色235特殊规则 =====
    if (h1.type === HAND_TYPES.MIXED_235 && h2.type === HAND_TYPES.THREE_OF_KIND) return 1;
    if (h1.type === HAND_TYPES.THREE_OF_KIND && h2.type === HAND_TYPES.MIXED_235) return -1;
    if (h1.type === HAND_TYPES.MIXED_235 && h2.type !== HAND_TYPES.MIXED_235) return -1;
    if (h1.type !== HAND_TYPES.MIXED_235 && h2.type === HAND_TYPES.MIXED_235) return 1;
    // 两个杂色235互相比 → 和局
    if (h1.type === HAND_TYPES.MIXED_235 && h2.type === HAND_TYPES.MIXED_235) return 0;

    // ===== 正常牌型比较 =====
    if (h1.type !== h2.type) return h1.type - h2.type;

    // 对子
    if (h1.type === HAND_TYPES.PAIR) {
        if (h1.pairValue !== h2.pairValue) return h1.pairValue - h2.pairValue;
        return h1.kicker - h2.kicker;
    }

    // 顺子特殊处理（A23是最小顺子）
    if (h1.type === HAND_TYPES.STRAIGHT) {
        const h1IsLow = h1.lowStraight === true;
        const h2IsLow = h2.lowStraight === true;
        if (h1IsLow && !h2IsLow) return -1;  // A23 vs 非A23 → A23输
        if (!h1IsLow && h2IsLow) return 1;   // 非A23 vs A23 → A23输
        if (h1IsLow && h2IsLow) return 0;    // 都是A23 → 和局
        // 都不是A23，按最大牌比
        const a = [...h1.values].sort((x,y) => y-x);
        const b = [...h2.values].sort((x,y) => y-x);
        for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    }

    // 豹子、金花、顺金、对子、单张：降序比较
    const a = [...h1.values].sort((x,y) => y-x);
    const b = [...h2.values].sort((x,y) => y-x);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// ==================== 游戏房间 ====================

const ROOM_ID = 'main';
const MAX_PLAYERS = 6;
const INITIAL_BASE_BET = 5;
const RAISED_BASE_BET = 10;
const MAX_ROUNDS = 20;

let room = null;

function createRoom() {
    return {
        players: [], deck: [], pot: 0,
        baseBet: INITIAL_BASE_BET, hasRaised: false,
        currentPlayerIndex: -1, dealerIndex: 0,
        round: 0, phase: 'waiting',
        lastWinner: -1, huoxiPlayerId: -1,
        hostId: null,
        dealerActedThisRound: false,
        compareLock: null,
        becameHeadsUpAtRound: -1
    };
}

function getActivePlayers() {
    return room.players.filter(p => p.status === 'active');
}

function nextActiveFrom(idx) {
    for (let i = 1; i <= room.players.length; i++) {
        const ni = (idx + i) % room.players.length;
        if (room.players[ni].status === 'active') return ni;
    }
    return -1;
}

// ==================== Socket 处理 ====================

io.on('connection', (socket) => {
    console.log('[连接] ' + socket.id);

    socket.on('join', (data) => handleJoin(socket, data));
    socket.on('start_game', () => handleStartGame(socket));
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('disconnect', () => handleDisconnect(socket));
});

function handleJoin(socket, { name }) {
    if (!room) room = createRoom();

    if (room.phase !== 'waiting' && room.phase !== 'playing' && room.phase !== 'gameover') {
        return socket.emit('error_msg', '房间状态异常，请稍候');
    }

    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (existingPlayer) {
        socket.join(ROOM_ID);
        socket.emit('joined', { playerIndex: room.players.indexOf(existingPlayer) });
        socket.emit('state_update', buildStateForPlayer(existingPlayer));
        if (room.compareLock) {
            const pi = room.compareLock.initiator;
            const ti = room.compareLock.target;
            if (existingPlayer === room.players[pi] && !existingPlayer.hasSelectedCards) {
                socket.emit('your_cards', { cards: existingPlayer.allCards });
            }
            if (existingPlayer === room.players[ti] && !existingPlayer.hasSelectedCards) {
                socket.emit('your_cards', { cards: existingPlayer.allCards });
            }
        }
        return;
    }

    if (room.players.length >= MAX_PLAYERS) return socket.emit('error_msg', '房间已满');
    if (room.hostId === null) room.hostId = socket.id;

    let initialStatus = 'active';
    if (room.phase === 'playing') initialStatus = 'waiting';

    const player = {
        id: socket.id,
        name: (name || '玩家').substring(0, 8),
        chips: 0, cards: [], allCards: [], discardedCards: [],
        status: initialStatus, bet: 0, handType: null,
        hasLooked: false, hasSelectedCards: false,
        baoxi: false, firstRoundAction: true, headsUpBetCount: 0,
        justCompared: false
    };

    room.players.push(player);
    socket.join(ROOM_ID);
    socket.emit('joined', { playerIndex: room.players.length - 1 });
    broadcastWaiting();

    if (room.phase === 'playing' || room.phase === 'gameover') {
        socket.emit('state_update', buildStateForPlayer(player));
    }
}

function handleDisconnect(socket) {
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const name = room.players[idx].name;
    const wasHost = room.hostId === socket.id;

    if (room.compareLock &&
        (room.compareLock.initiator === idx || room.compareLock.target === idx)) {
        room.compareLock = null;
    }

    room.players.splice(idx, 1);
    console.log('[离开] ' + name + (wasHost ? ' (房主)' : ''));

    if (room.players.length === 0) { room = null; return; }

    if (wasHost) {
        room.hostId = room.players[0].id;
        io.to(ROOM_ID).emit('host_changed', {
            newHostId: room.hostId,
            newHostName: room.players[0].name
        });
    }

    if (room.huoxiPlayerId === idx) room.huoxiPlayerId = -1;
    else if (room.huoxiPlayerId > idx) room.huoxiPlayerId--;
    if (room.lastWinner === idx) room.lastWinner = -1;
    else if (room.lastWinner > idx) room.lastWinner--;
    if (room.dealerIndex === idx) room.dealerIndex = 0;
    else if (room.dealerIndex > idx) room.dealerIndex--;

    if (room.currentPlayerIndex === idx) {
        if (room.phase === 'playing' && getActivePlayers().length > 0) {
            room.currentPlayerIndex = nextActiveFrom(idx > 0 ? idx - 1 : 0);
        } else {
            room.currentPlayerIndex = -1;
        }
    } else if (room.currentPlayerIndex > idx) {
        room.currentPlayerIndex--;
    }

    if (room.compareLock) {
        if (room.compareLock.initiator > idx) room.compareLock.initiator--;
        if (room.compareLock.target > idx) room.compareLock.target--;
    }

    if (room.phase === 'playing') {
        const activePlayers = getActivePlayers();
        if (activePlayers.length <= 1) handleEndOfRound(activePlayers[0] || null);
        else broadcastState();
    } else {
        broadcastState();
        broadcastWaiting();
    }
}

function broadcastWaiting() {
    if (!room) return;
    io.to(ROOM_ID).emit('waiting', {
        players: room.players.map(p => ({
            name: p.name,
            isHost: p.id === room.hostId,
            status: p.status
        })),
    });
}

// ==================== 游戏流程 ====================

function handleStartGame(socket) {
    if (!room) return socket.emit('error_msg', '房间不存在');

    const playableCount = room.players.filter(p =>
        p.status === 'active' || p.status === 'waiting' || p.status === 'folded'
    ).length;
    if (playableCount < 2) return socket.emit('error_msg', '至少需要2名玩家');

    const hostExists = room.players.some(p => p.id === room.hostId);
    const isHost = socket.id === room.hostId;
    if (!isHost && hostExists) return socket.emit('error_msg', '只有房主能开始游戏');
    if (!hostExists) room.hostId = socket.id;

    room.players.forEach(p => {
        if (p.status === 'folded' || p.status === 'waiting') p.status = 'active';
    });

    room.phase = 'playing';
    room.round = 1;
    room.hasRaised = false;
    room.baseBet = INITIAL_BASE_BET;
    room.pot = 0;
    room.dealerActedThisRound = false;
    room.huoxiPlayerId = -1;
    room.compareLock = null;
    room.becameHeadsUpAtRound = -1;

    room.deck = createDeck();
    shuffle(room.deck);

    room.players.forEach(p => {
        p.cards = []; p.allCards = []; p.discardedCards = [];
        p.bet = 0; p.handType = null;
        p.hasLooked = false; p.hasSelectedCards = false;
        p.baoxi = false; p.firstRoundAction = true; p.headsUpBetCount = 0;
        p.justCompared = false;
    });

    room.players.forEach(p => {
        p.allCards = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
        p.cards = []; p.discardedCards = []; p.handType = null;
    });

    if (room.lastWinner >= 0 && room.lastWinner < room.players.length) {
        room.dealerIndex = room.lastWinner;
    } else {
        room.dealerIndex = 0;
    }

    room.currentPlayerIndex = nextActiveFrom(room.dealerIndex);
    collectAnte();

    if (getActivePlayers().length === 2) {
        room.becameHeadsUpAtRound = 1;
    }

    broadcastState();
    io.to(ROOM_ID).emit('game_started', {
        dealerIndex: room.dealerIndex,
        currentPlayerIndex: room.currentPlayerIndex
    });
    addLog('系统', '游戏开始，每人下底注' + INITIAL_BASE_BET + '元');
}

function collectAnte() {
    if (room.huoxiPlayerId >= 0 && room.huoxiPlayerId < room.players.length) {
        const hp = room.players[room.huoxiPlayerId];
        if (hp) {
            const total = INITIAL_BASE_BET * room.players.length;
            hp.chips -= total;
            room.pot += total;
            room.players.forEach(p => { p.bet = INITIAL_BASE_BET; });
            addLog(hp.name, '支付所有底注' + total + '元', 'huoxi');
        }
        room.huoxiPlayerId = -1;
    } else {
        room.huoxiPlayerId = -1;
        room.players.forEach(p => {
            p.chips -= INITIAL_BASE_BET;
            p.bet = INITIAL_BASE_BET;
            room.pot += INITIAL_BASE_BET;
        });
    }
}

function handleAction(socket, data) {
    if (!room || room.phase !== 'playing') return;

    const { action, target, selectedIndices } = data;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;

    // ========== 敲牌锁定检查 ==========
    if (room.compareLock) {
        const cl = room.compareLock;
        const isInitiator = playerIdx === cl.initiator;
        const isTarget = playerIdx === cl.target;

        if (!isInitiator && !isTarget) {
            return socket.emit('error_msg', '敲牌进行中，请等待...');
        }

        if (action !== 'select_cards' && action !== 'fold') {
            if (isInitiator && !cl.initiatorWon) {
                return socket.emit('error_msg', '请等待敲牌结果...');
            }
            if (isTarget) {
                return socket.emit('error_msg', '请先选择你的手牌或弃牌');
            }
            if (isInitiator && cl.initiatorWon && action !== 'call') {
                return socket.emit('error_msg', '敲牌后只能跟注或弃牌');
            }
        }
    } else {
        const cp = room.players[room.currentPlayerIndex];
        if (!cp || cp.id !== socket.id) return socket.emit('error_msg', '不是你的回合');
        if (cp.status !== 'active') return socket.emit('error_msg', '你当前无法操作');
    }

    if (room.currentPlayerIndex === room.dealerIndex) {
        room.dealerActedThisRound = true;
    }

    const p = room.players[playerIdx];

    switch (action) {
        case 'fold': {
            if (room.compareLock) {
                const cl = room.compareLock;
                if (playerIdx === cl.target) {
                    p.status = 'folded';
                    addLog(p.name, '弃牌（敲牌认输）', 'fold');
                    io.to(ROOM_ID).emit('compare_result', {
                        winner: cl.initiator,
                        loser: cl.target
                    });
                    addLog(room.players[cl.initiator].name, '敲牌赢了 ' + p.name, 'compare');
                    room.compareLock = null;
                    const active = getActivePlayers();
                    if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }
                    room.players[cl.initiator].justCompared = true;
                    room.currentPlayerIndex = cl.initiator;
                    broadcastState();
                    return;
                } else if (playerIdx === cl.initiator) {
                    p.status = 'folded';
                    addLog(p.name, '弃牌（敲牌认输）', 'fold');
                    io.to(ROOM_ID).emit('compare_result', {
                        winner: cl.target,
                        loser: cl.initiator
                    });
                    addLog(room.players[cl.target].name, '敲牌赢了 ' + p.name, 'compare');
                    room.compareLock = null;
                    const active = getActivePlayers();
                    if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }
                    room.currentPlayerIndex = nextActiveFrom(cl.initiator);
                    nextTurn();
                    return;
                }
            }

            p.status = 'folded';
            p.firstRoundAction = false;
            p.justCompared = false;
            addLog(p.name, '弃牌', 'fold');
            break;
        }

        case 'look':
            p.hasLooked = true;
            addLog(p.name, '看牌', 'look');
            io.to(ROOM_ID).emit('player_looked', { playerIndex: playerIdx });
            socket.emit('your_cards', { cards: p.allCards });
            broadcastState();
            return;

        case 'select_cards': {
            if (p.hasSelectedCards) return socket.emit('error_msg', '你已经选过牌了');

            const isCompareParticipant = room.compareLock &&
                (playerIdx === room.compareLock.initiator || playerIdx === room.compareLock.target);
            if (!p.hasLooked && !isCompareParticipant) {
                return socket.emit('error_msg', '请先看牌');
            }

            if (!selectedIndices || selectedIndices.length !== 3) return socket.emit('error_msg', '请选择3张牌');
            for (const idx of selectedIndices) {
                if (idx < 0 || idx >= 5) return socket.emit('error_msg', '选择的牌无效');
            }

            const selectedCards = [];
            const discardedCards = [];
            for (let i = 0; i < 5; i++) {
                if (selectedIndices.includes(i)) selectedCards.push(p.allCards[i]);
                else discardedCards.push(p.allCards[i]);
            }
            p.cards = selectedCards;
            p.discardedCards = discardedCards;
            p.handType = evaluateHand(p.cards);
            p.hasSelectedCards = true;
            addLog(p.name, '选择了3张牌', 'select');

            if (room.compareLock) {
                const cl = room.compareLock;
                const initiator = room.players[cl.initiator];
                const targetP = room.players[cl.target];
                if (initiator.hasSelectedCards && targetP.hasSelectedCards) {
                    executeCompare(cl.initiator, cl.target);
                    return;
                }
            }

            broadcastState();
            return;
        }

        case 'call': {
            const amt = p.hasLooked ? room.baseBet * 2 : room.baseBet;
            p.chips -= amt;
            p.bet += amt;
            room.pot += amt;

            if (getActivePlayers().length === 2) p.headsUpBetCount++;

            if (room.round === 1 && !p.hasLooked && p.firstRoundAction) {
                p.baoxi = true;
                addLog(p.name, '跟注 ' + amt + '（报喜！）', 'baoxi');
            } else {
                addLog(p.name, '跟注 ' + amt, 'call');
            }
            p.firstRoundAction = false;
            p.justCompared = false;
            break;
        }

        case 'raise': {
            room.baseBet = RAISED_BASE_BET;
            room.hasRaised = true;
            const amt = p.hasLooked ? room.baseBet * 2 : room.baseBet;
            p.chips -= amt;
            p.bet += amt;
            room.pot += amt;

            if (getActivePlayers().length === 2) p.headsUpBetCount++;

            if (room.round === 1 && !p.hasLooked && p.firstRoundAction) {
                p.baoxi = true;
                addLog(p.name, '加注 ' + amt + '（报喜！）', 'baoxi');
            } else {
                addLog(p.name, '加注 ' + amt, 'raise');
            }
            p.firstRoundAction = false;
            break;
        }

        case 'compare': {
            if (target === undefined || target === playerIdx) return;
            const t = room.players[target];
            if (!t || t.status !== 'active') return socket.emit('error_msg', '目标无效');

            const amt = p.hasLooked ? room.baseBet * 2 : room.baseBet;
            p.chips -= amt;
            p.bet += amt;
            room.pot += amt;
            addLog(p.name, '向 ' + t.name + ' 发起敲牌', 'compare');

            if (p.hasSelectedCards && t.hasSelectedCards) {
                executeCompare(playerIdx, target);
                return;
            }

            room.compareLock = {
                initiator: playerIdx,
                target: target,
                initiatorWon: false
            };

            if (!p.hasSelectedCards) {
                socket.emit('your_cards', { cards: p.allCards });
            }
            if (!t.hasSelectedCards) {
                const tSocket = [...io.sockets.sockets.values()].find(s => s.id === t.id);
                if (tSocket) tSocket.emit('your_cards', { cards: t.allCards });
            }

            addLog(p.name, '等待双方选牌后比牌', 'compare');
            broadcastState();
            return;
        }

        default: return;
    }

    const active = getActivePlayers();
    if (active.length <= 1) {
        handleEndOfRound(active[0] || null);
        return;
    }

    nextTurn();
}

function executeCompare(initiatorIdx, targetIdx) {
    const p = room.players[initiatorIdx];
    const t = room.players[targetIdx];

    if (!p || !t || p.status !== 'active' || t.status !== 'active') {
        room.compareLock = null;
        broadcastState();
        return;
    }

    if (!p.hasSelectedCards) {
        p.cards = p.allCards.slice(0, 3);
        p.discardedCards = p.allCards.slice(3);
        p.handType = evaluateHand(p.cards);
        p.hasSelectedCards = true;
    }
    if (!t.hasSelectedCards) {
        t.cards = t.allCards.slice(0, 3);
        t.discardedCards = t.allCards.slice(3);
        t.handType = evaluateHand(t.cards);
        t.hasSelectedCards = true;
    }

    const result = compareHands(p.handType, t.handType);
    addLog(p.name, '敲牌比较: ' + p.handType.desc + ' vs ' + t.handType.desc, 'compare');

    if (result > 0) {
        t.status = 'folded';
        addLog(p.name, '敲牌赢了 ' + t.name, 'compare');
        io.to(ROOM_ID).emit('compare_result', { winner: initiatorIdx, loser: targetIdx });

        room.compareLock = null;
        const active = getActivePlayers();
        if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }

        p.justCompared = true;
        room.currentPlayerIndex = initiatorIdx;
        broadcastState();
    } else {
        p.status = 'folded';
        addLog(p.name, '敲牌输给了 ' + t.name, 'compare');
        io.to(ROOM_ID).emit('compare_result', { winner: targetIdx, loser: initiatorIdx });

        room.compareLock = null;
        const active = getActivePlayers();
        if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }

        room.currentPlayerIndex = nextActiveFrom(initiatorIdx);
        nextTurn();
    }
}

function nextTurn() {
    if (room.compareLock) return;

    room.currentPlayerIndex = nextActiveFrom(room.currentPlayerIndex);

    if (getActivePlayers().length === 2 && room.becameHeadsUpAtRound === -1) {
        room.becameHeadsUpAtRound = room.round;
    }

    if (room.dealerActedThisRound) {
        const firstActiveAfterDealer = nextActiveFrom(room.dealerIndex);
        if (room.currentPlayerIndex <= firstActiveAfterDealer) {
            room.round++;
            room.dealerActedThisRound = false;
        }
    }

    if (room.round > MAX_ROUNDS) {
        forceShowdown();
        return;
    }
    broadcastState();
}

function handleEndOfRound(winner) {
    room.phase = 'gameover';
    room.compareLock = null;
    if (winner) {
        if (!winner.handType) {
            if (!winner.cards || winner.cards.length < 3) {
                winner.cards = winner.allCards ? winner.allCards.slice(0, 3) : [];
            }
            if (winner.cards.length === 3) winner.handType = evaluateHand(winner.cards);
        }
        winner.chips += room.pot;
        room.lastWinner = room.players.indexOf(winner);
        checkHuoxi(winner);

        const desc = winner.handType ? winner.handType.desc : '未知牌型';
        addLog(winner.name, '赢得 ' + room.pot + ' 筹码（' + desc + '）', 'call');
        io.to(ROOM_ID).emit('game_over', {
            winnerIndex: room.players.indexOf(winner),
            winnerName: winner.name,
            pot: room.pot,
            handDesc: desc
        });
    }
    broadcastState();
}

function forceShowdown() {
    room.phase = 'gameover';
    room.compareLock = null;
    const active = getActivePlayers();
    let winner = null;
    active.forEach(p => {
        if (!p.handType) {
            if (!p.cards || p.cards.length < 3) p.cards = p.allCards ? p.allCards.slice(0, 3) : [];
            if (p.cards.length === 3) p.handType = evaluateHand(p.cards);
        }
        if (p.handType && (!winner || compareHands(p.handType, winner.handType) > 0)) winner = p;
    });
    if (winner) {
        winner.chips += room.pot;
        room.lastWinner = room.players.indexOf(winner);
        checkHuoxi(winner);
        const desc = winner.handType ? winner.handType.desc : '未知牌型';
        addLog(winner.name, '赢得 ' + room.pot + ' 筹码', 'call');
        io.to(ROOM_ID).emit('game_over', {
            winnerIndex: room.players.indexOf(winner),
            winnerName: winner.name,
            pot: room.pot,
            handDesc: desc
        });
    }
    broadcastState();
}

function checkHuoxi(winner) {
    if (!winner || !winner.baoxi || !winner.handType) return;
    if (winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH || winner.handType.type === HAND_TYPES.THREE_OF_KIND) {
        const bonus = winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH ? 20 : 30;
        const typeName = winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH ? '顺金' : '豹子';
        room.players.forEach(p => {
            if (p.id !== winner.id) { p.chips -= bonus; winner.chips += bonus; }
        });
        room.huoxiPlayerId = room.players.indexOf(winner);
        addLog(winner.name, '报喜成功！获' + typeName + '喜钱' + bonus + '元', 'huoxi');
    }
}

function addLog(name, action, type) {
    io.to(ROOM_ID).emit('log', {
        name, action, type: type || 'default',
        round: room ? room.round : 0
    });
}

// ==================== 状态广播 ====================

function getAvailableActions(player) {
    if (!player || player.status !== 'active') return [];

    if (room.compareLock) {
        const cl = room.compareLock;
        const pi = room.players.indexOf(player);
        if (pi === cl.initiator && cl.initiatorWon) {
            return ['fold', 'call'];
        }
        if (pi === cl.initiator || pi === cl.target) {
            return ['fold', 'select_cards'];
        }
        return [];
    }

    if (player.justCompared) return ['fold', 'call'];

    const actions = ['fold'];
    if (player.hasLooked && !player.hasSelectedCards) return ['select_cards'];

    if (!player.hasLooked) actions.push('look');
    actions.push('call');
    if (!room.hasRaised) actions.push('raise');

    if (room.round >= 2) {
        const active = getActivePlayers();
        if (canCompare(player, active)) actions.push('compare');
    }

    return actions;
}

function canCompare(player, active) {
    if (player.hasLooked && !player.hasSelectedCards) return false;

    if (active.length === 2) {
        const opp = active.find(p => p.id !== player.id);
        if (!opp) return false;

        if (player.hasLooked && player.hasSelectedCards && opp.hasLooked && opp.hasSelectedCards) {
            return true;
        }
        if (player.hasLooked && player.hasSelectedCards && !opp.hasLooked) {
            if (room.becameHeadsUpAtRound > 0 && room.round > room.becameHeadsUpAtRound) {
                return opp.headsUpBetCount >= 3;
            }
            return false;
        }
        if (!player.hasLooked && opp.hasLooked && opp.hasSelectedCards) {
            return true;
        }
        if (!player.hasLooked && !opp.hasLooked) {
            return opp.headsUpBetCount >= 3;
        }
        return false;
    }

    if (player.hasSelectedCards) {
        return active.some(p => p.id !== player.id && p.hasSelectedCards);
    }
    return false;
}

function getCompareTargets(player) {
    if (room.round < 2) return [];
    const active = getActivePlayers();

    if (active.length === 2) {
        const opp = active.find(p => p.id !== player.id);
        if (!opp) return [];

        if (player.hasLooked && player.hasSelectedCards && opp.hasLooked && opp.hasSelectedCards) {
            return [room.players.indexOf(opp)];
        }
        if (player.hasLooked && player.hasSelectedCards && !opp.hasLooked) {
            if (room.becameHeadsUpAtRound > 0 && room.round > room.becameHeadsUpAtRound && opp.headsUpBetCount >= 3) {
                return [room.players.indexOf(opp)];
            }
            return [];
        }
        if (!player.hasLooked && opp.hasLooked && opp.hasSelectedCards) {
            return [room.players.indexOf(opp)];
        }
        if (!player.hasLooked && !opp.hasLooked) {
            if (opp.headsUpBetCount >= 3) return [room.players.indexOf(opp)];
            return [];
        }
        return [];
    }

    if (player.hasSelectedCards) {
        return active.filter(p => p.id !== player.id && p.hasSelectedCards).map(p => room.players.indexOf(p));
    }
    return [];
}

function broadcastState() {
    if (!room) return;
    room.players.forEach(p => {
        io.to(p.id).emit('state_update', buildStateForPlayer(p));
    });
}

function buildStateForPlayer(viewer) {
    const viewerIndex = room.players.indexOf(viewer);
    const hostPlayer = room.players.find(p => p.id === room.hostId);

    let compareLockInfo = null;
    if (room.compareLock) {
        compareLockInfo = {
            initiatorIndex: room.compareLock.initiator,
            targetIndex: room.compareLock.target,
            initiatorWon: room.compareLock.initiatorWon
        };
    }

    return {
        pot: room.pot,
        baseBet: room.baseBet,
        round: room.round,
        phase: room.phase,
        currentPlayerIndex: room.currentPlayerIndex,
        dealerIndex: room.dealerIndex,
        myIndex: viewerIndex,
        hostId: room.hostId,
        hostName: hostPlayer ? hostPlayer.name : '',
        compareLock: compareLockInfo,
        hasRaised: room.hasRaised,
        players: room.players.map((p, i) => {
            let showCards = [];
            let showDiscarded = [];
            let showAllCards = false;

            if (i === viewerIndex) {
                if (p.hasLooked && !p.hasSelectedCards) {
                    showCards = p.allCards;
                    showAllCards = true;
                } else if (p.hasSelectedCards) {
                    showCards = p.cards;
                }
            } else {
                if (room.phase === 'gameover') {
                    showCards = p.cards;
                    showDiscarded = p.discardedCards;
                } else if (p.hasSelectedCards) {
                    showDiscarded = p.discardedCards;
                }
            }

            return {
                name: p.name,
                chips: p.chips,
                bet: p.bet,
                status: p.status,
                hasLooked: p.hasLooked,
                hasSelectedCards: p.hasSelectedCards,
                baoxi: p.baoxi,
                cards: showCards,
                discardedCards: showDiscarded,
                showAllCards: showAllCards,
                handDesc: (showCards.length === 3 && p.handType) ? p.handType.desc : ''
            };
        }),
        availableActions: (viewer.status === 'active' && !room.compareLock && room.currentPlayerIndex === viewerIndex)
            ? getAvailableActions(viewer)
            : (room.compareLock && viewer.status === 'active')
                ? getAvailableActions(viewer)
                : [],
        compareTargets: (viewer.status === 'active' && !room.compareLock && room.currentPlayerIndex === viewerIndex)
            ? getCompareTargets(viewer)
            : []
    };
}

// ==================== 启动 ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🃏 炸金花服务已启动，端口: ' + PORT);
});
