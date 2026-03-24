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
        dealerActedThisRound: false
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
    socket.on('select_cards', (data) => handleSelectCards(socket, data));
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
        const state = buildStateForPlayer(existingPlayer);
        socket.emit('state_update', state);
        return;
    }

    if (room.players.length >= MAX_PLAYERS) return socket.emit('error_msg', '房间已满');

    if (room.hostId === null) room.hostId = socket.id;

    let initialStatus = 'active';
    if (room.phase === 'playing') {
        initialStatus = 'waiting';
    }

    const player = {
        id: socket.id,
        name: (name || '玩家').substring(0, 8),
        chips: 0,
        cards: [],              // 所有5张牌
        selectedCards: [],      // 选中的3张牌索引
        discardedCards: [],     // 弃掉的2张牌索引
        finalCards: [],         // 最终选中的3张牌
        status: initialStatus,
        bet: 0,
        handType: null,
        hasLooked: false,
        hasSelectedCards: false, // 是否已完成选牌
        baoxi: false,
        firstRoundAction: true,
        headsUpBetCount: 0
    };

    room.players.push(player);
    socket.join(ROOM_ID);
    socket.emit('joined', { playerIndex: room.players.length - 1 });
    broadcastWaiting();

    if (room.phase === 'playing' || room.phase === 'gameover') {
        const state = buildStateForPlayer(player);
        socket.emit('state_update', state);
    }
}

function handleDisconnect(socket) {
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    const name = room.players[idx].name;
    const wasHost = room.hostId === socket.id;
    room.players.splice(idx, 1);
    console.log('[离开] ' + name + (wasHost ? ' (房主)' : ''));

    if (room.players.length === 0) {
        room = null;
        return;
    }

    // 【关键修复】如果离开的是房主，立即广播房主变更
    if (wasHost) {
        room.hostId = room.players[0].id;
        console.log('[房主转移] ' + room.players[0].name);

        // 立即广播房主变更事件
        io.to(ROOM_ID).emit('host_changed', {
            newHostId: room.hostId,
            newHostName: room.players[0].name
        });
    }

    // 更新索引
    if (room.lastWinner === idx) {
        room.lastWinner = -1;
    } else if (room.lastWinner > idx) {
        room.lastWinner--;
    }

    if (room.dealerIndex === idx) {
        room.dealerIndex = 0;
    } else if (room.dealerIndex > idx) {
        room.dealerIndex--;
    }

    if (room.currentPlayerIndex === idx) {
        if (room.phase === 'playing' && getActivePlayers().length > 0) {
            room.currentPlayerIndex = nextActiveFrom(idx > 0 ? idx - 1 : 0);
        } else {
            room.currentPlayerIndex = -1;
        }
    } else if (room.currentPlayerIndex > idx) {
        room.currentPlayerIndex--;
    }

    if (room.phase === 'playing') {
        const activePlayers = getActivePlayers();
        if (activePlayers.length <= 1) {
            handleEndOfRound(activePlayers[0] || null);
        } else {
            broadcastState();
        }
    } else {
        // 【关键修复】无论什么阶段，都广播状态更新
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
    if (!hostExists) {
        room.hostId = socket.id;
    }

    room.players.forEach(p => {
        if (p.status === 'folded' || p.status === 'waiting') {
            p.status = 'active';
        }
    });

    room.phase = 'playing';
    room.round = 1;
    room.hasRaised = false;
    room.baseBet = INITIAL_BASE_BET;
    room.pot = 0;
    room.dealerActedThisRound = false;

    room.deck = createDeck();
    shuffle(room.deck);

    room.players.forEach(p => {
        p.cards = [];
        p.selectedCards = [];
        p.discardedCards = [];
        p.finalCards = [];
        p.bet = 0;
        p.handType = null;
        p.hasLooked = false;
        p.hasSelectedCards = false;
        p.baoxi = false;
        p.firstRoundAction = true;
        p.headsUpBetCount = 0;
    });

    // 发5张牌给每个玩家
    room.players.forEach(p => {
        p.cards = [
            room.deck.pop(), 
            room.deck.pop(), 
            room.deck.pop(), 
            room.deck.pop(), 
            room.deck.pop()
        ];
        // 初始时，handType为null，需要等玩家选牌后才能确定
        p.handType = null;
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
        const total = INITIAL_BASE_BET * room.players.length;
        hp.chips -= total;
        room.pot += total;
        room.players.forEach(p => { p.bet = INITIAL_BASE_BET; });
        addLog(hp.name, '支付所有底注' + total + '元', 'huoxi');
        room.huoxiPlayerId = -1;
    } else {
        room.players.forEach(p => {
            p.chips -= INITIAL_BASE_BET;
            p.bet = INITIAL_BASE_BET;
            room.pot += INITIAL_BASE_BET;
        });
    }
}

// 新增：处理选牌
function handleSelectCards(socket, data) {
    if (!room || room.phase !== 'playing') return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return socket.emit('error_msg', '玩家不存在');
    
    if (!player.hasLooked) {
        return socket.emit('error_msg', '请先看牌');
    }
    
    if (player.hasSelectedCards) {
        return socket.emit('error_msg', '已经选过牌了');
    }
    
    const { selectedIndices } = data;
    
    if (!selectedIndices || !Array.isArray(selectedIndices) || selectedIndices.length !== 3) {
        return socket.emit('error_msg', '请选择3张牌');
    }
    
    // 验证索引有效性
    for (let idx of selectedIndices) {
        if (idx < 0 || idx >= 5 || !Number.isInteger(idx)) {
            return socket.emit('error_msg', '无效的牌索引');
        }
    }
    
    // 确保索引不重复
    const uniqueIndices = [...new Set(selectedIndices)];
    if (uniqueIndices.length !== 3) {
        return socket.emit('error_msg', '请选择3张不同的牌');
    }
    
    // 设置选中的牌和弃掉的牌
    player.selectedCards = selectedIndices.sort((a, b) => a - b);
    player.discardedCards = [0, 1, 2, 3, 4].filter(i => !selectedIndices.includes(i));
    
    // 设置最终牌
    player.finalCards = selectedIndices.map(i => player.cards[i]);
    
    // 计算牌型
    player.handType = evaluateHand(player.finalCards);
    
    // 标记已完成选牌
    player.hasSelectedCards = true;
    
    addLog(player.name, '完成选牌', 'look');
    
    // 广播状态更新
    broadcastState();
}

function handleAction(socket, data) {
    if (!room || room.phase !== 'playing') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return socket.emit('error_msg', '不是你的回合');
    if (cp.status !== 'active') return socket.emit('error_msg', '你当前无法操作');

    if (room.currentPlayerIndex === room.dealerIndex) {
        room.dealerActedThisRound = true;
    }

    const { action, target } = data;
    const p = cp;

    switch (action) {
        case 'fold':
            p.status = 'folded';
            p.firstRoundAction = false;
            // 【修改】清除敲牌胜利标记
            p.justCompared = false;
            addLog(p.name, '弃牌', 'fold');
            break;

        case 'look':
            p.hasLooked = true;
            addLog(p.name, '看牌', 'look');
            io.to(ROOM_ID).emit('player_looked', {
                playerIndex: room.currentPlayerIndex
            });
            socket.emit('your_cards', { cards: p.cards, hasSelectedCards: p.hasSelectedCards });
            broadcastState();
            return;

        case 'call': {
            // 必须先选牌才能跟注
            if (!p.hasSelectedCards) {
                return socket.emit('error_msg', '请先看牌并选择3张牌');
            }
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
        
            // 【修改】清除敲牌胜利标记
            p.justCompared = false;
            break;
        }

        case 'raise': {
            // 必须先选牌才能加注
            if (!p.hasSelectedCards) {
                return socket.emit('error_msg', '请先看牌并选择3张牌');
            }
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
            // 必须先选牌才能敲牌
            if (!p.hasSelectedCards) {
                return socket.emit('error_msg', '请先看牌并选择3张牌');
            }
            if (target === undefined || target === room.currentPlayerIndex) return;
            const t = room.players[target];
            if (!t || t.status !== 'active') return socket.emit('error_msg', '目标无效');
        
            const cost = getCompareCost(p);
            p.chips -= cost;
            p.bet += cost;
            room.pot += cost;
        
            const result = compareHands(p.handType, t.handType);
            addLog(p.name, '向 ' + t.name + ' 敲牌', 'compare');
        
            if (result > 0) {
                t.status = 'folded';
                addLog(p.name, '敲牌赢了 ' + t.name, 'compare');
                io.to(ROOM_ID).emit('compare_result', {
                    winner: room.currentPlayerIndex,
                    loser: target
                });
        
                // 【修改】敲牌胜利后，检查是否只剩自己一人
                const active = getActivePlayers();
                if (active.length <= 1) {
                    handleEndOfRound(active[0] || null);
                    return;
                }
        
                // 【修改】设置标记，当前玩家只能继续跟注
                p.justCompared = true;
                broadcastState();
                return;
            } else {
                p.status = 'folded';
                addLog(p.name, '敲牌输给了 ' + t.name, 'compare');
                io.to(ROOM_ID).emit('compare_result', {
                    winner: target,
                    loser: room.currentPlayerIndex
                });
            }
            break;
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

function getCompareCost(player) {
    if (getActivePlayers().length === 2) {
        const opp = getActivePlayers().find(p => p.id !== player.id);
        if (opp && !player.hasLooked && !opp.hasLooked && opp.headsUpBetCount >= 3)
            return room.baseBet;
    }
    return player.hasLooked ? room.baseBet * 2 : room.baseBet;
}

function nextTurn() {
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
    if (winner) {
        winner.chips += room.pot;
        room.lastWinner = room.players.indexOf(winner);
        checkHuoxi(winner);
        addLog(winner.name, '赢得 ' + room.pot + ' 筹码（' + winner.handType.desc + '）', 'call');
        io.to(ROOM_ID).emit('game_over', {
            winnerIndex: room.players.indexOf(winner),
            winnerName: winner.name,
            pot: room.pot,
            handDesc: winner.handType ? winner.handType.desc : ''
        });
    }
    broadcastState();
}

function forceShowdown() {
    room.phase = 'gameover';
    const active = getActivePlayers();
    let winner = null;
    active.forEach(p => {
        if (!winner || compareHands(p.handType, winner.handType) > 0) winner = p;
    });
    if (winner) {
        winner.chips += room.pot;
        room.lastWinner = room.players.indexOf(winner);
        checkHuoxi(winner);
        addLog(winner.name, '赢得 ' + room.pot + ' 筹码', 'call');
        io.to(ROOM_ID).emit('game_over', {
            winnerIndex: room.players.indexOf(winner),
            winnerName: winner.name,
            pot: room.pot,
            handDesc: winner.handType ? winner.handType.desc : ''
        });
    }
    broadcastState();
}

function checkHuoxi(winner) {
    if (winner.baoxi && winner.handType &&
        (winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH || winner.handType.type === HAND_TYPES.THREE_OF_KIND)) {
        const bonus = winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH ? 20 : 30;
        const typeName = winner.handType.type === HAND_TYPES.STRAIGHT_FLUSH ? '顺金' : '豹子';

        room.players.forEach(p => {
            if (p.id !== winner.id) {
                p.chips -= bonus;
                winner.chips += bonus;
            }
        });

        room.huoxiPlayerId = room.players.indexOf(winner);
        addLog(winner.name, '报喜成功！获' + typeName + '喜钱' + bonus + '元', 'huoxi');
    }
}

function addLog(name, action, type) {
    io.to(ROOM_ID).emit('log', {
        name,
        action,
        type: type || 'default',
        round: room ? room.round : 0
    });
}

// ==================== 状态广播 ====================

function getAvailableActions(player) {
    if (!player || player.status !== 'active') return [];

    // 【修改】如果刚敲牌胜利，只能跟注或弃牌
    if (player.justCompared) {
        return ['fold', 'call'];
    }

    const actions = ['fold'];
    if (!player.hasLooked) actions.push('look');
    
    // 只有完成选牌后才能跟注、加注、敲牌
    if (player.hasSelectedCards) {
        actions.push('call');
        if (!room.hasRaised) actions.push('raise');

        const active = getActivePlayers();
        if (room.round >= 2) {
            if (active.length === 2) {
                const opp = active.find(p => p.id !== player.id);
                if (opp) {
                    if (opp.hasLooked) actions.push('compare');
                    else if (!opp.hasLooked && opp.headsUpBetCount >= 3) actions.push('compare');
                }
            } else if (player.hasLooked && active.some(p => p.id !== player.id && p.hasLooked)) {
                actions.push('compare');
            }
        }
    }

    return actions;
}

function getCompareTargets(player) {
    if (room.round < 2) return [];
    const active = getActivePlayers();
    if (active.length === 2) {
        const opp = active.find(p => p.id !== player.id);
        if (opp) {
            if (opp.hasLooked) return [room.players.indexOf(opp)];
            if (!opp.hasLooked && opp.headsUpBetCount >= 3) return [room.players.indexOf(opp)];
        }
        return [];
    }
    if (!player.hasLooked) return [];
    return active.filter(p => p.id !== player.id && p.hasLooked).map(p => room.players.indexOf(p));
}

function broadcastState() {
    if (!room) return;
    room.players.forEach((p) => {
        const state = buildStateForPlayer(p);
        io.to(p.id).emit('state_update', state);
    });
}

function buildStateForPlayer(viewer) {
    const viewerIndex = room.players.indexOf(viewer);
    const hostPlayer = room.players.find(p => p.id === room.hostId);
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
        players: room.players.map((p, i) => {
            // 自己看牌后可以看到自己的5张牌
            // 游戏结束时可以看到所有人的最终牌
            const showAllCards = (p.hasLooked && i === viewerIndex) || (room.phase === 'gameover');
            // 弃牌（未选中的牌）对所有人可见（如果该玩家已选牌）
            const showDiscarded = p.hasSelectedCards;
            
            return {
                name: p.name,
                chips: p.chips,
                bet: p.bet,
                status: p.status,
                hasLooked: p.hasLooked,
                hasSelectedCards: p.hasSelectedCards,
                baoxi: p.baoxi,
                // 自己看牌后可以看到所有5张牌
                cards: showAllCards ? p.cards : [],
                // 最终选中的3张牌（游戏结束时显示）
                finalCards: (room.phase === 'gameover' && p.finalCards) ? p.finalCards : (i === viewerIndex && p.hasSelectedCards ? p.finalCards : []),
                // 弃掉的牌（对所有人可见）
                discardedCards: showDiscarded ? p.discardedCards.map(idx => p.cards[idx]) : [],
                selectedIndices: (i === viewerIndex && p.hasLooked) ? p.selectedCards : [],
                handDesc: ((showAllCards || room.phase === 'gameover') && p.handType) ? p.handType.desc : ''
            };
        }),
        availableActions: (room.currentPlayerIndex === viewerIndex && viewer.status === 'active')
            ? getAvailableActions(viewer)
            : [],
        compareTargets: (room.currentPlayerIndex === viewerIndex && viewer.status === 'active')
            ? getCompareTargets(viewer)
            : []
    };
}

// ==================== 启动 ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('🃏 炸金花服务已启动，端口: ' + PORT);
});
