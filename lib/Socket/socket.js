"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSocket = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const url_1 = require("url");
const util_1 = require("util");
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const Client_1 = require("./Client");

const makeSocket = (config) => {
    var _a, _b;
    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository, } = config;
    const url = typeof waWebSocketUrl === 'string' ? new url_1.URL(waWebSocketUrl) : waWebSocketUrl;
    if (config.mobile || url.protocol === 'tcp:') {
        throw new boom_1.Boom('Mobile API is not supported anymore', { statusCode: Types_1.DisconnectReason.loggedOut });
    }
    if (url.protocol === 'wss' && ((_a = authState === null || authState === void 0 ? void 0 : authState.creds) === null || _a === void 0 ? void 0 : _a.routingInfo)) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }
    const ws = new Client_1.WebSocketClient(url, config);
    ws.connect();
    const ev = (0, Utils_1.makeEventBuffer)(logger);
    const ephemeralKeyPair = Utils_1.Curve.generateKeyPair();
    const noise = (0, Utils_1.makeNoiseHandler)({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: Defaults_1.NOISE_WA_HEADER,
        logger,
        routingInfo: (_b = authState === null || authState === void 0 ? void 0 : authState.creds) === null || _b === void 0 ? void 0 : _b.routingInfo
    });
    const { creds } = authState;
    const keys = (0, Utils_1.addTransactionCapability)(authState.keys, logger, transactionOpts);
    const signalRepository = makeSignalRepository({ creds, keys });
    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;
    const uqTagId = (0, Utils_1.generateMdTagPrefix)();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = (0, util_1.promisify)(ws.send);

    const sendRawMessage = async (data) => {
        try {
            if (!ws.isOpen) {
                throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
            }
            const bytes = noise.encodeFrame(data);
            await (0, Utils_1.promiseTimeout)(connectTimeoutMs, async (resolve, reject) => {
                try {
                    await sendPromise.call(ws, bytes);
                    resolve();
                }
                catch (error) {
                    reject(error || new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed }));
                }
            });
        } catch (err) {
            logger.error({ err }, 'Error in sendRawMessage');
            throw err;
        }
    };

    const sendNode = (frame) => {
        try {
            if (logger.level === 'trace') {
                logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'xml send' });
            }
            const buff = (0, WABinary_1.encodeBinaryNode)(frame);
            return sendRawMessage(buff);
        } catch (error) {
            logger.error({ error }, 'Error sending node');
        }
    };

    // 🔧 REPARADO: Manejo mejorado de errores Bad MAC
    const onUnexpectedError = (err, msg) => {
        const errorMessage = (err && ((err.stack || err.message) || String(err))).toLowerCase();
        
        // Loggear el error pero no propagarlo si es de cifrado
        logger.error({ err }, `unexpected error in '${msg}'`);
        
        // Manejo específico para errores de MAC/criptografía - NO propagar estos errores
        if (errorMessage.includes('bad mac') || 
            (errorMessage.includes('mac') && errorMessage.includes('invalid')) ||
            errorMessage.includes('failed to decrypt') ||
            errorMessage.includes('session error') ||
            errorMessage.includes('libsignal')) {
            
            logger.warn('🔇 Error de cifrado detectado (Bad MAC/Session). Continuando conexión...');
            
            try {
                // Re-subir prekeys para forzar nueva sincronización
                uploadPreKeysToServerIfRequired(true)
                    .then(() => logger.info('✅ Prekeys re-subidas después de error MAC'))
                    .catch(e => logger.warn({ e }, 'Fallo al re-subir prekeys'));
                    
            } catch (cleanupErr) {
                logger.warn({ cleanupErr }, 'Error limpiando sesiones');
            }
            
            // IMPORTANTE: No propagar el error si es solo de cifrado
            // Estos errores son recuperables y no deben cerrar la conexión
            return; 
        }
        
        // Rate limiting
        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
            const wait = Math.min(30000, (config.backoffDelayMs || 5000));
            logger.info({ wait }, 'backing off due to rate limit');
            setTimeout(() => { }, wait);
        }
    };

    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
        }
        let onOpen;
        let onClose;
        const result = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);
            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        })
        .finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
        if (sendMsg) {
            sendRawMessage(sendMsg).catch(err => {
                if (onClose) onClose(err);
            });
        }
        return result;
    };

    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv;
        let onErr;
        try {
            const result = await (0, Utils_1.promiseTimeout)(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => {
                    reject(err || new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed }));
                };
                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr);
                ws.on('error', onErr);
            });
            return result;
        }
        finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr); 
            ws.off('error', onErr);
        }
    };

    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }
        const msgId = node.attrs.id;
        try {
            const [result] = await Promise.all([
                waitForMessage(msgId, timeoutMs),
                sendNode(node)
            ]);
            if (result && 'tag' in result) {
                (0, WABinary_1.assertNodeErrorFree)(result);
            }
            return result;
        } catch (error) {
            throw error;
        }
    };

    const validateConnection = async () => {
        try {
            let helloMsg = { clientHello: { ephemeral: ephemeralKeyPair.public } };
            helloMsg = WAProto_1.proto.HandshakeMessage.fromObject(helloMsg);
            logger.info({ browser, helloMsg }, 'connected to WA');
            const init = WAProto_1.proto.HandshakeMessage.encode(helloMsg).finish();
            const result = await awaitNextMessage(init);
            const handshake = WAProto_1.proto.HandshakeMessage.decode(result);
            logger.trace({ handshake }, 'handshake recv from WA');
            const keyEnc = await noise.processHandshake(handshake, creds.noiseKey);
            let node;
            if (!creds.me) {
                node = (0, Utils_1.generateRegistrationNode)(creds, config);
                logger.info({ node }, 'not logged in, attempting registration...');
            }
            else {
                node = (0, Utils_1.generateLoginNode)(creds.me.id, config);
                logger.info({ node }, 'logging in...');
            }
            const payloadEnc = noise.encrypt(WAProto_1.proto.ClientPayload.encode(node).finish());
            await sendRawMessage(WAProto_1.proto.HandshakeMessage.encode({
                clientFinish: { static: keyEnc, payload: payloadEnc },
            }).finish());
            noise.finishInit();
            startKeepAliveRequest();
        } catch (err) {
            logger.error({ err }, 'error in validating connection');
            end(err);
        }
    };

    const getAvailablePreKeysOnServer = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                xmlns: 'encrypt',
                type: 'get',
                to: WABinary_1.S_WHATSAPP_NET
            },
            content: [{ tag: 'count', attrs: {} }]
        });
        const countChild = (0, WABinary_1.getBinaryNodeChild)(result, 'count');
        return +countChild.attrs.value;
    };

    const uploadPreKeys = async (count = Defaults_1.INITIAL_PREKEY_COUNT) => {
        await keys.transaction(async () => {
            logger.info({ count }, 'uploading pre-keys');
            const { update, node } = await (0, Utils_1.getNextPreKeysNode)({ creds, keys }, count);
            await query(node);
            ev.emit('creds.update', update);
            logger.info({ count }, 'uploaded pre-keys');
        });
    };

    const uploadPreKeysToServerIfRequired = async (force = false) => {
        try {
            const preKeyCount = await getAvailablePreKeysOnServer();
            logger.info(`${preKeyCount} pre-keys found on server`);
            if (force || preKeyCount <= Defaults_1.MIN_PREKEY_COUNT) {
                await uploadPreKeys();
            }
        } catch (err) {
            logger.warn({ err }, 'Error checking/uploading prekeys');
        }
    };

    const onMessageReceived = (data) => {
        noise.decodeFrame(data, frame => {
            var _a;
            lastDateRecv = new Date();
            let anyTriggered = false;
            anyTriggered = ws.emit('frame', frame);
            if (!(frame instanceof Uint8Array)) {
                const msgId = frame.attrs.id;
                if (logger.level === 'trace') {
                    logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'recv xml' });
                }
                anyTriggered = ws.emit(`${Defaults_1.DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered;
                const l0 = frame.tag;
                const l1 = frame.attrs || {};
                const l2 = Array.isArray(frame.content) ? (_a = frame.content[0]) === null || _a === void 0 ? void 0 : _a.tag : '';
                for (const key of Object.keys(l1)) {
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered;
                    anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered;
                }
                anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered;
                anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered;
                if (!anyTriggered && logger.level === 'debug') {
                    logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv');
                }
            }
        });
    };

    const end = (error) => {
        if (closed) return;
        closed = true;
        logger.info({ trace: error === null || error === void 0 ? void 0 : error.stack }, error ? 'connection errored' : 'connection closed');
        clearInterval(keepAliveReq);
        clearTimeout(qrTimer);
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        ws.removeAllListeners('open');
        ws.removeAllListeners('message');
        if (!ws.isClosed && !ws.isClosing) {
            try { ws.close(); } catch (_a) { }
        }
        ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error, date: new Date() }
        });
        ev.removeAllListeners('connection.update');
    };

    const waitForSocketOpen = async () => {
        if (ws.isOpen) return;
        if (ws.isClosed || ws.isClosing) {
            throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed });
        }
        let onOpen;
        let onClose;
        await new Promise((resolve, reject) => {
            onOpen = () => resolve(undefined);
            onClose = mapWebSocketError(reject);
            ws.on('open', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        })
        .finally(() => {
            ws.off('open', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });
    };

    const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
        if (!lastDateRecv) lastDateRecv = new Date();
        const diff = Date.now() - lastDateRecv.getTime();
        if (diff > keepAliveIntervalMs + 5000) {
            end(new boom_1.Boom('Connection was lost', { statusCode: Types_1.DisconnectReason.connectionLost }));
        }
        else if (ws.isOpen) {
            query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:p',
                },
                content: [{ tag: 'ping', attrs: {} }]
            }).catch(err => {
                logger.error({ trace: err.stack }, 'error in sending keep alive');
            });
        }
    }, keepAliveIntervalMs));

    const sendPassiveIq = (tag) => (query({
        tag: 'iq',
        attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'passive', type: 'set' },
        content: [{ tag, attrs: {} }]
    }));

    const logout = async (msg) => {
        var _a;
        const jid = (_a = authState.creds.me) === null || _a === void 0 ? void 0 : _a.id;
        if (jid) {
            await sendNode({
                tag: 'iq',
                attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
                content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }]
            });
        }
        end(new boom_1.Boom(msg || 'Intentional Logout', { statusCode: Types_1.DisconnectReason.loggedOut }));
    };

    const requestPairingCode = async (phoneNumber, pairKey) => {
        try {
            if (!pairKey) {
                const randomSuffix = (0, crypto_1.randomBytes)(2).toString('hex').toUpperCase().slice(0, 4);
                pairKey = `ASTA${randomSuffix}`;
            }
            authState.creds.pairingCode = pairKey.toUpperCase();
            authState.creds.me = {
                id: (0, WABinary_1.jidEncode)(phoneNumber, 's.whatsapp.net'),
                name: '~'
            };
            ev.emit('creds.update', authState.creds);
            await sendNode({
                tag: 'iq',
                attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
                content: [
                    {
                        tag: 'link_code_companion_reg',
                        attrs: {
                            jid: authState.creds.me.id,
                            stage: 'companion_hello',
                            should_show_push_notification: 'true'
                        },
                        content: [
                            { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: await generatePairingKey() },
                            { tag: 'companion_server_auth_key_pub', attrs: {}, content: authState.creds.noiseKey.public },
                            { tag: 'companion_platform_id', attrs: {}, content: (0, Utils_1.getPlatformId)(browser[1]) },
                            { tag: 'companion_platform_display', attrs: {}, content: `${browser[1]} (${browser[0]})` },
                            { tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
                        ]
                    }
                ]
            });
            return authState.creds.pairingCode;
        } catch (error) {
            logger.error({ error }, 'Error requesting pairing code');
            throw error;
        }
    };

    async function generatePairingKey() {
        const salt = (0, crypto_1.randomBytes)(32);
        const randomIv = (0, crypto_1.randomBytes)(16);
        const key = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, salt);
        const ciphered = (0, Utils_1.aesEncryptCTR)(authState.creds.pairingEphemeralKeyPair.public, key, randomIv);
        return Buffer.concat([salt, randomIv, ciphered]);
    }

    const sendWAMBuffer = (wamBuffer) => {
        return query({
            tag: 'iq',
            attrs: { to: WABinary_1.S_WHATSAPP_NET, id: generateMessageTag(), xmlns: 'w:stats' },
            content: [{ tag: 'add', attrs: {}, content: wamBuffer }]
        });
    };

    ws.on('message', onMessageReceived);
    ws.on('open', async () => {
        try { await validateConnection(); }
        catch (err) {
            logger.error({ err }, 'error in validating connection');
            end(err);
        }
    });
    ws.on('error', mapWebSocketError(end));
    ws.on('close', () => end(new boom_1.Boom('Connection Terminated', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    ws.on('CB:xmlstreamend', () => end(new boom_1.Boom('Connection Terminated by Server', { statusCode: Types_1.DisconnectReason.connectionClosed })));
    
    ws.on('CB:iq,type:set,pair-device', async (stanza) => {
        const iq = { tag: 'iq', attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id } };
        await sendNode(iq);
        const pairDeviceNode = (0, WABinary_1.getBinaryNodeChild)(stanza, 'pair-device');
        const refNodes = (0, WABinary_1.getBinaryNodeChildren)(pairDeviceNode, 'ref');
        const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64');
        const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64');
        const advB64 = creds.advSecretKey;
        let qrMs = qrTimeout || 60000;
        const genPairQR = () => {
            if (!ws.isOpen) return;
            const refNode = refNodes.shift();
            if (!refNode) {
                end(new boom_1.Boom('QR refs attempts ended', { statusCode: Types_1.DisconnectReason.timedOut }));
                return;
            }
            const ref = refNode.content.toString('utf-8');
            const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
            ev.emit('connection.update', { qr });
            qrTimer = setTimeout(genPairQR, qrMs);
            qrMs = qrTimeout || 20000;
        };
        genPairQR();
    });

    ws.on('CB:iq,,pair-success', async (stanza) => {
        try {
            const { reply, creds: updatedCreds } = (0, Utils_1.configureSuccessfulPairing)(stanza, creds);
            ev.emit('creds.update', updatedCreds);
            ev.emit('connection.update', { isNewLogin: true, qr: undefined });
            await sendNode(reply);
        }
        catch (error) {
            end(error);
        }
    });

    ws.on('CB:success', async (node) => {
        try {
            await uploadPreKeysToServerIfRequired();
            await sendPassiveIq('active');
            clearTimeout(qrTimer);
            ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } });
            ev.emit('connection.update', { connection: 'open' });
        }
        catch (err) {
            end(err);
        }
    });

    ws.on('CB:stream:error', (node) => {
        const { reason, statusCode } = (0, Utils_1.getErrorCodeFromStreamError)(node);
        end(new boom_1.Boom(`Stream Errored (${reason})`, { statusCode, data: node }));
    });

    ws.on('CB:failure', (node) => {
        const reason = +(node.attrs.reason || 500);
        end(new boom_1.Boom('Connection Failure', { statusCode: reason, data: node.attrs }));
    });

    ws.on('CB:ib,,edge_routing', (node) => {
        const edgeRoutingNode = (0, WABinary_1.getBinaryNodeChild)(node, 'edge_routing');
        const routingInfo = (0, WABinary_1.getBinaryNodeChild)(edgeRoutingNode, 'routing_info');
        if (routingInfo === null || routingInfo === void 0 ? void 0 : routingInfo.content) {
            authState.creds.routingInfo = Buffer.from(routingInfo === null || routingInfo === void 0 ? void 0 : routingInfo.content);
            ev.emit('creds.update', authState.creds);
        }
    });

    let didStartBuffer = false;
    process.nextTick(() => {
        var _a;
        if ((_a = creds.me) === null || _a === void 0 ? void 0 : _a.id) {
            ev.buffer();
            didStartBuffer = true;
        }
        ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined });
    });

    ws.on('CB:ib,,offline', (node) => {
        const child = (0, WABinary_1.getBinaryNodeChild)(node, 'offline');
        const offlineNotifs = +((child === null || child === void 0 ? void 0 : child.attrs.count) || 0);
        if (didStartBuffer) ev.flush();
        ev.emit('connection.update', { receivedPendingNotifications: true });
    });

    ev.on('creds.update', update => {
        var _a, _b;
        const name = (_a = update.me) === null || _a === void 0 ? void 0 : _a.name;
        if (((_b = creds.me) === null || _b === void 0 ? void 0 : _b.name) !== name) {
            sendNode({ tag: 'presence', attrs: { name: name } })
                .catch(err => logger.warn({ trace: err.stack }, 'presence error'));
        }
        Object.assign(creds, update);
    });

    if (printQRInTerminal) (0, Utils_1.printQRIfNecessaryListener)(ev, logger);

    return {
        type: 'md',
        ws,
        ev,
        authState: { creds, keys },
        signalRepository,
        get user() { return authState.creds.me; },
        generateMessageTag,
        query,
        waitForMessage,
        waitForSocketOpen,
        sendRawMessage,
        sendNode,
        logout,
        end,
        onUnexpectedError,
        uploadPreKeys,
        uploadPreKeysToServerIfRequired,
        requestPairingCode,
        waitForConnectionUpdate: (0, Utils_1.bindWaitForConnectionUpdate)(ev),
        sendWAMBuffer,
    };
};
exports.makeSocket = makeSocket;

function mapWebSocketError(handler) {
    return (error) => {
        handler(new boom_1.Boom(`WebSocket Error (${error === null || error === void 0 ? void 0 : error.message})`, { statusCode: (0, Utils_1.getCodeFromWSError)(error), data: error }));
    };
}
