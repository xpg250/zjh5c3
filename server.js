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
const HAND_TYPES = { SINGLE:1, PAIR:2, STRAIGHT:3, FLUSH:4, STRAIGHT_FLUSH:5, THREE_OF_KIND:6 };
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

function evaluateHand(cards) {
    const values = cards.map(c => c.value).sort((a, b) => a - b);
    const suits = cards.map(c => c.suit);
    const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
    const isThree = values[0] === values[1] && values[1] === values[2];
    const isStraight = (values[1] === values[0]+1 && values[2] === values[1]+1) || (values[0]===2 && values[1]===3 && values[2]===14);

    if (isThree) return { type: HAND_TYPES.THREE_OF_KIND, values, desc: '豹子' + valueName(values[0]) };
    if (isStraight && isFlush) return { type: HAND_TYPES.STRAIGHT_FLUSH, values, desc: '顺金' + valueName(values[2]) };
    if (isStraight) return { type: HAND_TYPES.STRAIGHT, values, desc: '顺子' + valueName(values[2]) };
    if (isFlush) return { type: HAND_TYPES.FLUSH, values, desc: '金花' + valueName(values[2]) };

    let pairValue = 0, kicker = 0;
    if (values[0] === values[1]) { pairValue = values[0]; kicker = values[2]; }
    else if (values[1] === values[2]) { pairValue = values[1]; kicker = values[0]; }
    else if (values[0] === values[2]) { pairValue = values[0]; kicker = values[1]; }
    if (pairValue) return { type: HAND_TYPES.PAIR, values, pairValue, kicker, desc: '对' + valueName(pairValue) };

    return { type: HAND_TYPES.SINGLE, values, desc: '单张' + valueName(values[2]) };
}

function compareHands(h1, h2) {
    if (h1.type !== h2.type) return h1.type - h2.type;
    if (h1.type === HAND_TYPES.PAIR) {
        if (h1.pairValue !== h2.pairValue) return h1.pairValue - h2.pairValue;
        return h1.kicker - h2.kicker;
    }
    const a = [...h1.values].sort((x,y) => y-x);
    const b = [...h2.values].sort((x,y) => y-x);
    const isA23 = v => v[0]===2 && v[1]===3 && v[2]===14;
    const sa = [...h1.values].sort((x,y)=>x-y), sb = [...h2.values].sort((x,y)=>x-y);
    if (isA23(sa) && !isA23(sb)) return -1;
    if (!isA23(sa) && isA23(sb)) return 1;
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
        // 敲牌锁定：发起后游戏暂停，只有双方可操作
        compareLock: null
        // compareLock 结构: { initiator: idx, target: idx, initiatorWon: false }
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
        // 重连时如果有敲牌锁定，重新发送手牌给未选牌的参与者
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
        baoxi: false, firstRoundAction: true, headsUpBetCount: 0
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

    // 如果敲牌锁定涉及该玩家，取消锁定
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

    // 修正索引
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

    room.deck = createDeck();
    shuffle(room.deck);

    room.players.forEach(p => {
        p.cards = []; p.allCards = []; p.discardedCards = [];
        p.bet = 0; p.handType = null;
        p.hasLooked = false; p.hasSelectedCards = false;
        p.baoxi = false; p.firstRoundAction = true; p.headsUpBetCount = 0;
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

        // 非参与者一律拒绝
        if (!isInitiator && !isTarget) {
            return socket.emit('error_msg', '敲牌进行中，请等待...');
        }

        // 参与者只允许 select_cards / fold
        if (action !== 'select_cards' && action !== 'fold') {
            if (isInitiator && !cl.initiatorWon) {
                return socket.emit('error_msg', '请等待敲牌结果...');
            }
            if (isTarget) {
                return socket.emit('error_msg', '请先选择你的手牌或弃牌');
            }
            // 发起者赢了之后可以 call（在下面正常流程处理）
            if (isInitiator && cl.initiatorWon && action !== 'call') {
                return socket.emit('error_msg', '敲牌后只能跟注或弃牌');
            }
        }
    } else {
        // 没有锁定时，必须轮到该玩家
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
            // 敲牌锁定中：参与者弃牌 = 认输
            if (room.compareLock) {
                const cl = room.compareLock;
                if (playerIdx === cl.target) {
                    // 目标弃牌 → 发起者赢
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
                    // 发起者赢 → 可以继续行动
                    room.players[cl.initiator].justCompared = true;
                    room.currentPlayerIndex = cl.initiator;
                    broadcastState();
                    return;
                } else if (playerIdx === cl.initiator) {
                    // 发起者弃牌 → 目标赢
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

            // 正常弃牌
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
            // 修改：看牌后立即发送手牌给玩家，触发选牌界面
            socket.emit('your_cards', { cards: p.allCards });
            broadcastState();
            return;

        case 'select_cards': {
            if (p.hasSelectedCards) return socket.emit('error_msg', '你已经选过牌了');
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

            // 检查敲牌锁定：双方都选完牌则执行比较
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

            // 双方都已选牌 → 直接比较
            if (p.hasSelectedCards && t.hasSelectedCards) {
                executeCompare(playerIdx, target);
                return;
            }

            // 设置敲牌锁定，游戏暂停
            room.compareLock = {
                initiator: playerIdx,
                target: target,
                initiatorWon: false
            };

            // 修改：给双方中所有未选牌的玩家发送手牌（无论是否看牌）
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

// 执行敲牌比较
function executeCompare(initiatorIdx, targetIdx) {
    const p = room.players[initiatorIdx];
    const t = room.players[targetIdx];

    if (!p || !t || p.status !== 'active' || t.status !== 'active') {
        room.compareLock = null;
        broadcastState();
        return;
    }

    // 修改：不再自动为未选牌玩家分配手牌，而是检查双方是否都已选牌
    if (!p.hasSelectedCards || !t.hasSelectedCards) {
        // 如果有一方未选牌，不应执行比较，保持锁定状态
        addLog('系统', '等待双方完成选牌', 'compare');
        broadcastState();
        return;
    }

    const result = compareHands(p.handType, t.handType);
    addLog(p.name, '敲牌比较: ' + p.handType.desc + ' vs ' + t.handType.desc, 'compare');

    if (result > 0) {
        // 发起者赢
        t.status = 'folded';
        addLog(p.name, '敲牌赢了 ' + t.name, 'compare');
        io.to(ROOM_ID).emit('compare_result', { winner: initiatorIdx, loser: targetIdx });

        room.compareLock = null;
        const active = getActivePlayers();
        if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }

        // 赢家留在当前回合，可以继续行动（不可再敲）
        p.justCompared = true;
        room.currentPlayerIndex = initiatorIdx;
        broadcastState();
    } else {
        // 发起者输
        p.status = 'folded';
        addLog(p.name, '敲牌输给了 ' + t.name, 'compare');
        io.to(ROOM_ID).emit('compare_result', { winner: targetIdx, loser: initiatorIdx });

        room.compareLock = null;
        const active = getActivePlayers();
        if (active.length <= 1) { handleEndOfRound(active[0] || null); return; }

        // 进入下一玩家回合
        room.currentPlayerIndex = nextActiveFrom(initiatorIdx);
        nextTurn();
    }
}

function getCompareCost(player) {
    if (getActivePlayers().length === 2) {
        const opp = getActivePlayers().find(p => p.id !== player.id);
        if (opp && !player.hasLooked && !opp.hasLooked && opp.headsUpBetCount >= 3)
            return room.baseBet;
    }
    return player.hasLooked ? room.baseBet * 2 : room.baseBet;
}

function nextTurn() {
    // 敲牌锁定中不推进回合
    if (room.compareLock) return;

    room.currentPlayerIndex = nextActiveFrom(room.currentPlayerIndex);

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

    // 敲牌锁定中：发起者赢了之后只能 fold/call
    if (room.compareLock) {
        const cl = room.compareLock;
        const pi = room.players.indexOf(player);
        if (pi === cl.initiator && cl.initiatorWon) {
            return ['fold', 'call'];
        }
        return [];
    }

    if (player.justCompared) return ['fold', 'call'];

    const actions = ['fold'];
    // 修改：已看牌未选牌 → 提供“选牌”操作（通过触发 your_cards 事件实现）
    if (player.hasLooked && !player.hasSelectedCards) {
        // 客户端会将此动作转换为显示选牌界面
        return ['select_cards_ui'];
    }

    if (!player.hasLooked) actions.push('look');
    actions.push('call');
    if (!room.hasRaised) actions.push('raise');

    // 敲牌：第2轮起
    if (room.round >= 2) {
        const active = getActivePlayers();
        if (canCompare(player, active)) actions.push('compare');
    }

    return actions;
}

function canCompare(player, active) {
    // 已看牌未选牌 → 不可敲
    if (player.hasLooked && !player.hasSelectedCards) return false;

    if (active.length === 2) {
        const opp = active.find(p => p.id !== player.id);
        if (!opp) return false;

        if (player.hasLooked && player.hasSelectedCards) {
            // 已看牌：可敲已选牌对手，或暗牌且跟注>=3次的对手
            if (opp.hasSelectedCards) return true;
            if (!opp.hasLooked && opp.headsUpBetCount >= 3) return true;
            return false;
        } else if (!player.hasLooked) {
            // 未看牌：可敲任何人
            return true;
        }
        return false;
    }

    // 3+人：已选牌玩家之间互敲
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

        if (player.hasLooked && player.hasSelectedCards) {
            if (opp.hasSelectedCards) return [room.players.indexOf(opp)];
            if (!opp.hasLooked && opp.headsUpBetCount >= 3) return [room.players.indexOf(opp)];
            return [];
        } else if (!player.hasLooked) {
            return [room.players.indexOf(opp)];
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
