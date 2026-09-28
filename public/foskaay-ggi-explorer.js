// public/foskaay-ggi-explorer.js
// Reads-only Foskaay GGI explorer helpers. NO writes, NO keys, NO backend: every
// value on the explorer comes from the Arc contracts + RPC directly, which is the
// point (a dev or a grant reviewer can verify the claim without trusting us).
//
// The core has no per-session storage beyond the commitment, so a session is
// proven by its EVENTS: Handover (connect) and Settled (result), on the single
// FoskaayGGI, plus the midchain move log (signed, hash-chained) when the
// game publishes it. This file reads those with eth_getLogs and the relay.
(function () {
    'use strict';

    var NETS = {
        testnet: {
            name: 'Arc Testnet',
            chainId: 5042002,
            rpc: 'https://rpc.testnet.arc.io',
            explorer: 'https://explorer.testnet.arc.io',
            usdc: '0x3600000000000000000000000000000000000000',
            relay: '/api/foskaay-ggi-sponsor',
            contracts: {
                FoskaayGGI: '0x793785CE66992211B7c60dFCf0318869678D33a4',
                FoskaayGGIGames: '0x24e38ac2e80958782a8Bc5CD479bbe2e5D81EcDF',
                FoskaayGGIPlayers: '0x1614ebc72eA1cB3D31975b3976B5B474FAcE3b3C',
                FoskaayGGILudo: '0xa5040Ece5945a8551499ad1148fc3cD15b165987'
            }
        },
        mainnet: {
            name: 'Arc Mainnet',
            chainId: 5042,
            rpc: 'https://rpc.mainnet.arc.io',
            explorer: 'https://explorer.arc.io',
            usdc: '0x3600000000000000000000000000000000000000',
            relay: '/api/foskaay-ggi-sponsor',
            contracts: {
                FoskaayGGI: '0xb406295b4F7E5B513b656122AfFF29AF720E9E23',
                FoskaayGGIGames: '0xb2d5DfF81B076948f50dA2CcF01887f5ed6Ae2b2',
                FoskaayGGIPlayers: '0x9425c1d6bA7923D5C804c5e549E08629AbBe3165',
                FoskaayGGILudo: null
            }
        }
    };
    var NET = NETS.testnet;

    // Switch the whole explorer between testnet and mainnet.
    function setNetwork(name) {
        if (NETS[name]) NET = NETS[name];
        try { window.dispatchEvent(new CustomEvent('ggi:net-changed', { detail: name })); } catch (e) {}
    }

    // Event topic0 hashes (keccak of the event signature). Recomputed with
    // `cast keccak "<signature>"`. If an event signature ever changes, recompute.
    var TOPIC = {
        Handover: '0xb111092a842748e6a1a5b34c24137f21e0ddf21a5caa8db5a885bdb5574209e1',
        Settled: '0x12e9909fa20d454f1d832410840022a48385ad716d10570278d043c3a15b6595'
    };

    // Precomputed view selectors, pinned so the page needs no crypto library.
    var SELECTORS = {
        'isPaid(bytes32)': '0xfeef6640',
        'fee()': '0xddca3f43',
        'feeBase()': '0x95e911a8',
        'feePerAccount()': '0x50b7c6e7',
        'feePerGame()': '0xd6ae481e',
        'gameCount(bytes32)': '0x892b48e6',
        'sessionGames(bytes32)': '0x83f5c065',
        'destination()': '0xb269681d',
        'midchainDigest(bytes32,bytes32)': '0x00918792',
        'commitments(bytes32)': '0x839df945'
    };

    function rpc(method, params) {
        return fetch(NET.rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] })
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.error) throw new Error(j.error.message || 'rpc error');
            return j.result;
        });
    }

    function ethCall(to, data) {
        return rpc('eth_call', [{ to: to, data: data }, 'latest']);
    }

    function callView(to, sig, argsData) {
        return ethCall(to, SELECTORS[sig] + (argsData || ''));
    }

    function getLogs(address, topic0, sessionId) {
        return rpc('eth_getLogs', [{
            address: address,
            topics: [topic0, sessionId],
            fromBlock: '0x0',
            toBlock: 'latest'
        }]);
    }

    // ---- tiny ABI decoding (no dependency) ------------------------------------
    function w(data, i) { return data.slice(2 + i * 64, 2 + (i + 1) * 64); }
    function addrFromWord(hexWord) { return '0x' + hexWord.slice(24); }
    function addrFromTopic(topic) { return '0x' + topic.slice(26); }
    function bytes32FromWord(hexWord) { return '0x' + hexWord; }
    function numFromWord(hexWord) { const h = String(hexWord || '0').replace(/^0x/, ''); return BigInt('0x' + h); }
    function boolFromHex(hex) { return hex && hex !== '0x' && BigInt(hex) !== 0n; }

    // Non-indexed Handover data: startHash, seedCommit, players[], sessionKeys[],
    // randomCount, counter.
    function decodeHandover(data) {
        if (!data || data.length < 2 + 6 * 64) return null;
        return {
            startHash: bytes32FromWord(w(data, 0)),
            seedCommit: bytes32FromWord(w(data, 1)),
            players: readAddrArray(data, Number(numFromWord(w(data, 2)))),
            sessionKeys: readAddrArray(data, Number(numFromWord(w(data, 3)))),
            randomCount: Number(numFromWord(w(data, 4))),
            counter: numFromWord(w(data, 5)).toString()
        };
    }

    // Non-indexed Settled data: finalHash, seedReveal
    function decodeSettled(data) {
        if (!data || data.length < 2 + 2 * 64) return null;
        return {
            finalHash: bytes32FromWord(w(data, 0)),
            seedReveal: bytes32FromWord(w(data, 1))
        };
    }

    // Dynamic address[] at a byte offset from the start of `data`.
    function readAddrArray(data, byteOffset) {
        var out = [];
        try {
            var len = Number(numFromWord(data.slice(2 + byteOffset * 2, 2 + byteOffset * 2 + 64)));
            for (var i = 0; i < len; i++) {
                var start = 2 + (byteOffset + 32 + i * 32) * 2 + 24;
                out.push('0x' + data.slice(start, start + 40));
            }
        } catch (e) { /* soft */ }
        return out;
    }

    // ---- Public API -----------------------------------------------------------

    function findLogInReceipt(rc, addr, topic0) {
        try {
            var logs = (rc && rc.logs) || [];
            for (var i = 0; i < logs.length; i++) {
                var L = logs[i];
                if (L.address && L.address.toLowerCase() === String(addr).toLowerCase() &&
                    L.topics && L.topics[0] === topic0) return L;
            }
        } catch (e) { /* soft */ }
        return null;
    }

    function handoverFromLog(hLog) {
        if (!hLog) return null;
        var d = decodeHandover(hLog.data) || {};
        return {
            gameLogic: hLog.topics[2] ? addrFromTopic(hLog.topics[2]) : null,
            payer: hLog.topics[3] ? addrFromTopic(hLog.topics[3]) : null,
            startHash: d.startHash, seedCommit: d.seedCommit,
            players: d.players || [], sessionKeys: d.sessionKeys || [],
            randomCount: d.randomCount || 0, counter: d.counter,
            block: Number(BigInt(hLog.blockNumber)),
            tx: hLog.transactionHash
        };
    }
    function settledFromLog(sLog) {
        if (!sLog) return null;
        var sd = decodeSettled(sLog.data) || {};
        return {
            finalHash: sd.finalHash, seedReveal: sd.seedReveal,
            payer: sLog.topics[2] ? addrFromTopic(sLog.topics[2]) : null,
            block: Number(BigInt(sLog.blockNumber)),
            tx: sLog.transactionHash
        };
    }

    function loadSession(sessionId) {
        var C = NET.contracts;
        var idArg = sessionId.replace(/^0x/, '');
        // The relay knows the session's connect/settle txs; decode the events from
        // the transaction receipts (robust, no block-0 scan). Fall back to logs.
        return fetch(NET.relay, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'demoSession', sessionId: sessionId })
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (meta) {
            function decodeFrom(topic0, tx) {
                if (!tx) return Promise.resolve(null);
                return rpc('eth_getTransactionReceipt', [tx]).then(function (rc) {
                    return findLogInReceipt(rc, C.FoskaayGGI, topic0);
                }).catch(function () { return null; });
            }
            return Promise.all([decodeFrom(TOPIC.Handover, meta && meta.connectTx), decodeFrom(TOPIC.Settled, meta && meta.settleTx)]).then(function (got) {
                // If the relay could not supply a tx, fall back to eth_getLogs.
                var p = [];
                p.push(got[0] ? Promise.resolve(got[0]) : getLogs(C.FoskaayGGI, TOPIC.Handover, sessionId).then(function (x) { return x[0] || null; }).catch(function () { return null; }));
                p.push(got[1] ? Promise.resolve(got[1]) : getLogs(C.FoskaayGGI, TOPIC.Settled, sessionId).then(function (x) { return x[0] || null; }).catch(function () { return null; }));
                return Promise.all(p);
            });
          })
          .then(function (r) {
            return Promise.all([
                Promise.resolve(r[0]), Promise.resolve(r[1]),
                callView(C.FoskaayGGI, 'isPaid(bytes32)', idArg).catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'fee()').catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'destination()').catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'feeBase()').catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'feePerAccount()').catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'feePerGame()').catch(function () { return '0x'; }),
                callView(C.FoskaayGGI, 'sessionGames(bytes32)', idArg).catch(function () { return '0x'; }),
                C.FoskaayGGIGames ? callView(C.FoskaayGGIGames, 'gameCount(bytes32)', idArg).catch(function () { return '0x'; }) : Promise.resolve('0x')
            ]).then(function (v) {
                return {
                    hLog: v[0], sLog: v[1], isPaidHex: v[2], feeHex: v[3], destHex: v[4],
                    feeBaseHex: v[5], feeAcctHex: v[6], feeGameHex: v[7], declaredHex: v[8], countHex: v[9]
                };
            });
          })
          .then(function (v) {
            var handover = handoverFromLog(v.hLog);
            var settled = settledFromLog(v.sLog);
            return {
                sessionId: sessionId,
                connected: Boolean(handover),
                handover: handover,
                settled: settled,
                paid: boolFromHex(v.isPaidHex),
                fee: numFromWord(v.feeHex || '0x0'),
                destination: v.destHex && v.destHex !== '0x' ? addrFromWord(v.destHex.slice(2)) : null,
                fees: {
                    base: v.feeBaseHex && v.feeBaseHex !== '0x' ? numFromWord(v.feeBaseHex) : 0n,
                    perAccount: v.feeAcctHex && v.feeAcctHex !== '0x' ? numFromWord(v.feeAcctHex) : 0n,
                    perGame: v.feeGameHex && v.feeGameHex !== '0x' ? numFromWord(v.feeGameHex) : 0n
                },
                declaredGames: v.declaredHex && v.declaredHex !== '0x' ? numFromWord(v.declaredHex) : 0n,
                gamesCommitted: v.countHex && v.countHex !== '0x' ? numFromWord(v.countHex) : 0n
            };
        });
    }

    // The published, signed move log for a session (untrusted cache; the anchor is
    // the on-chain final hash).
    function loadMoves(sessionId) {
        return fetch(NET.relay, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'demoMoves', sessionId: sessionId })
        }).then(function (r) { return r.json(); }).then(function (j) {
            return (j && j.ok) ? j : { found: false };
        }).catch(function () { return { found: false }; });
    }

    /// Verify the midchain: every move links to the previous hash and the LAST
    /// move's hash equals the on-chain settled final hash. A tampered move breaks
    /// the chain and cannot match the on-chain anchor.
    function verifyChain(sessionId) {
        return Promise.all([loadSession(sessionId), loadMoves(sessionId)]).then(function (r) {
            var session = r[0], log = r[1];
            var out = { sessionId: sessionId, hasLog: !!log.found, moves: (log && log.moves) || [], ok: false, reason: '', settled: session.settled };
            if (!log.found) { out.reason = 'No published move log for this session.'; return out; }
            var prev = log.startHash;
            for (var i = 0; i < out.moves.length; i++) {
                var m = out.moves[i];
                if (m.prevHash && prev && m.prevHash !== prev) { out.reason = 'Hash chain breaks at move ' + (i + 1) + '.'; return out; }
                prev = m.newHash;
            }
            if (session.settled && session.settled.finalHash && prev && session.settled.finalHash !== prev) {
                out.reason = 'The last move does not match the on-chain final hash.';
                return out;
            }
            out.ok = true;
            out.reason = session.settled
                ? 'Every move links to the next and the chain ends at the on-chain settled final hash.'
                : 'Every move links to the next. Settle to re-anchor the game session from the Foskaay GGI Midchain back to the Arc blockchain.';
            return out;
        });
    }

    // The exact digest the players sign. Pure read; costs nothing.
    function midchainDigest(sessionId, finalHash) {
        var args = sessionId.replace(/^0x/, '') + finalHash.replace(/^0x/, '');
        return callView(NET.contracts.FoskaayGGI, 'midchainDigest(bytes32,bytes32)', args);
    }

    window.GGExplorer = {
        NET: NET,
        NETS: NETS,
        setNetwork: setNetwork,
        TOPIC: TOPIC,
        rpc: rpc,
        callView: callView,
        loadSession: loadSession,
        loadMoves: loadMoves,
        verifyChain: verifyChain,
        midchainDigest: midchainDigest,
        decodeHandover: decodeHandover,
        decodeSettled: decodeSettled
    };
})();
