"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleButtonResponse = handleButtonResponse;
exports.setupButtonHandler = setupButtonHandler;

/**
 * Maneja las respuestas de botones y las convierte en comandos ejecutables
 */
async function handleButtonResponse(sock, m, plugins, db) {
    
    // ========== DETECTAR SOLO BOTONES ==========
    let seleccion = null
    let tipoBoton = null
    
    // Botón tipo quick_reply (interactive)
    if (m.mtype === 'interactiveResponseMessage') {
        const resp = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
        if (resp?.name === 'quick_reply') {
            seleccion = resp.id
            tipoBoton = 'quick_reply'
        }
    }
    
    // Botón tipo buttonsResponse (estilo antiguo)
    if (m.mtype === 'buttonsResponseMessage') {
        seleccion = m.message?.buttonsResponseMessage?.selectedButtonId
        tipoBoton = 'buttonsResponse'
    }
    
    // Lista desplegable
    if (m.mtype === 'listResponseMessage') {
        seleccion = m.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        tipoBoton = 'listResponse'
    }
    
    // Si no es botón, salir
    if (!seleccion) return false
    
    console.log(`[Baileys] Botón detectado [${tipoBoton}]:`, seleccion)
    
    // Limpiar el ID del botón
    let cmd = seleccion.toString().toLowerCase().replace(/^[.#!/]/, '').trim()
    
    // ========== BUSCAR PLUGIN ==========
    let pluginFound = null
    
    for (let name in plugins) {
        let plugin = plugins[name]
        if (!plugin || !plugin.command) continue
        
        let commands = Array.isArray(plugin.command) ? plugin.command : [plugin.command]
        
        const isMatch = commands.some(c => {
            if (c instanceof RegExp) return c.test(cmd)
            return c.toString().toLowerCase() === cmd
        })
        
        if (isMatch) {
            pluginFound = plugin
            break
        }
    }
    
    if (!pluginFound) {
        console.log(`[Baileys] No se encontró plugin para: ${cmd}`)
        await sock.sendMessage(m.chat, { 
            text: `❌ *Comando no encontrado*\n\nEl botón "${seleccion}" no tiene un comando asociado.` 
        }, { quoted: m })
        return true
    }
    
    // ========== OBTENER PERMISOS ==========
    const groupMetadata = m.isGroup ? await sock.groupMetadata(m.chat).catch(() => null) || {} : {}
    const participants = groupMetadata?.participants || []
    
    const isAdmin = m.isGroup ? participants.find(p => p.id === m.sender)?.admin === 'admin' || participants.find(p => p.id === m.sender)?.admin === 'superadmin' : false
    const isBotAdmin = m.isGroup ? participants.find(p => p.id === sock.user.id)?.admin === 'admin' || participants.find(p => p.id === sock.user.id)?.admin === 'superadmin' : false
    const isOwner = [...global.owner || []].map(v => v + "@s.whatsapp.net").includes(m.sender)
    
    // ========== VALIDAR PERMISOS ==========
    if (pluginFound.rowner && !isOwner) {
        await sock.sendMessage(m.chat, { text: `🔒 *Acceso denegado*\n\nEste comando es solo para los creadores del bot.` }, { quoted: m })
        return true
    }
    
    if (pluginFound.owner && !isOwner) {
        await sock.sendMessage(m.chat, { text: `🔒 *Acceso denegado*\n\nEste comando es solo para el owner del bot.` }, { quoted: m })
        return true
    }
    
    if (pluginFound.admin && !isAdmin) {
        await sock.sendMessage(m.chat, { text: `⚠️ *Permiso denegado*\n\nEste comando solo puede ser usado por administradores del grupo.` }, { quoted: m })
        return true
    }
    
    if (pluginFound.botAdmin && !isBotAdmin) {
        await sock.sendMessage(m.chat, { text: `🤖 *Bot sin permisos*\n\nNecesito ser administrador del grupo para ejecutar este comando.` }, { quoted: m })
        return true
    }
    
    if (pluginFound.group && !m.isGroup) {
        await sock.sendMessage(m.chat, { text: `👥 *Solo grupos*\n\nEste comando solo puede usarse en grupos.` }, { quoted: m })
        return true
    }
    
    if (pluginFound.private && m.isGroup) {
        await sock.sendMessage(m.chat, { text: `🔒 *Solo privado*\n\nEste comando solo puede usarse en chat privado.` }, { quoted: m })
        return true
    }
    
    // ========== EJECUTAR PLUGIN ==========
    try {
        await pluginFound.call(sock, m, {
            conn: sock,
            usedPrefix: '',
            command: cmd,
            args: [],
            text: '',
            participants,
            groupMetadata,
            isAdmin,
            isBotAdmin,
            isOwner,
            db
        })
        console.log(`[Baileys] Plugin ejecutado: ${cmd}`)
    } catch (error) {
        console.error(`[Baileys] Error:`, error)
        await sock.sendMessage(m.chat, { text: `❌ *Error al ejecutar el comando*\n\n${error.message || error}` }, { quoted: m })
    }
    
    return true
}

/**
 * Configura el handler de botones en el socket
 */
function setupButtonHandler(sock, plugins, db) {
    const originalHandler = sock.ev.listeners('messages.upsert')[0]
    
    sock.ev.off('messages.upsert', originalHandler)
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            const fueBoton = await handleButtonResponse(sock, m, plugins, db)
            if (!fueBoton && originalHandler) {
                await originalHandler({ messages: [m] })
            }
        }
    })
}
