"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeDecrypt = safeDecrypt;
exports.silenceBadMacErrors = silenceBadMacErrors;

/**
 * Envuelve una función para capturar y silenciar errores Bad MAC
 */
function safeDecrypt(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            if (error.message && error.message.includes('Bad MAC')) {
                console.log('[Baileys] 🔇 Bad MAC silenciado');
                return null;
            }
            throw error;
        }
    };
}

/**
 * Parchea los métodos de libsignal para no mostrar errores Bad MAC
 */
function silenceBadMacErrors() {
    const originalConsoleError = console.error;
    console.error = (...args) => {
        const message = args.join(' ');
        if (message.includes('Bad MAC') || 
            message.includes('Failed to decrypt') ||
            message.includes('No session found')) {
            return; // No mostrar
        }
        originalConsoleError(...args);
    };
}
