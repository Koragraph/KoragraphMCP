const winston = require('winston');
const { format } = winston;
const path = require('path');
const fs = require('fs');

// KORAGRAPH_HOME, not process.cwd(). The editor launches `koragraph mcp` with cwd set to the
// user's repository, so requiring this module wrote a logs/ directory with four rotating
// transports into their working tree — on a read-only query. This repo gitignores logs/; theirs
// does not. File logging is now opt-in via KORAGRAPH_LOG_DIR; otherwise only the (stderr)
// console transport runs.
const logDir = process.env.KORAGRAPH_LOG_DIR
    || (process.env.KORAGRAPH_HOME ? path.join(process.env.KORAGRAPH_HOME, 'logs') : null);
const fileLoggingEnabled = Boolean(logDir);
if (fileLoggingEnabled && !fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Custom format for timestamps
const timestampFormat = format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
});

// Custom format for log files
const fileFormat = format.combine(
    timestampFormat,
    format.errors({ stack: true }),
    format.json()
);

// Custom format for console
const consoleFormat = format.combine(
    format.colorize(),
    timestampFormat,
    format.printf(({ level, message, timestamp, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
            // Safe JSON stringify to handle circular references
            try {
                const seen = new WeakSet();
                const safeMetadata = JSON.parse(JSON.stringify(metadata, (key, value) => {
                    // Handle circular references
                    if (typeof value === 'object' && value !== null) {
                        if (seen.has(value)) {
                            return '[Circular Reference]';
                        }
                        seen.add(value);
                    }
                    return value;
                }));
                msg += JSON.stringify(safeMetadata);
            } catch (error) {
                // Fallback: just log the message without metadata
                msg += ' [Metadata could not be serialized]';
            }
        }
        return msg;
    })
);

// Create daily rotate file transport
const dailyRotateFile = require('winston-daily-rotate-file');

// In production containers, stdout is the log collector pipe — emit JSON.
const stdoutFormat = process.env.NODE_ENV === 'production'
    ? format.combine(timestampFormat, format.errors({ stack: true }), format.json())
    : consoleFormat;

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: fileFormat,
    transports: [
        // Console transport
        // Every level goes to stderr. winston's Console transport writes non-error levels via
        // console._stdout.write, which bypasses the console.log/console.info redirect that
        // src/mcp/start.js and src/cli/main.js rely on to keep stdout pure. blast-radius.js
        // logger.info()s on its cap paths and is wired into the MCP blast_radius tool, so an
        // ANSI-coloured line was landing in the JSON-RPC stream and killing the session.
        new winston.transports.Console({
            format: stdoutFormat,
            stderrLevels: Object.keys(winston.config.npm.levels),
        }),
        // File transports only when a log directory was configured — see logDir above.
        ...(fileLoggingEnabled ? [
            ['error-%DATE%.log', 'error'],
            ['info-%DATE%.log', 'info'],
            ['warn-%DATE%.log', 'warn'],
            ['combined-%DATE%.log', null],
        ].map(([filename, level]) => new dailyRotateFile({
            filename: path.join(logDir, filename),
            datePattern: 'YYYY-MM-DD',
            ...(level ? { level } : {}),
            maxSize: '20m',
            maxFiles: '14d',
        })) : []),
    ]
});

// Create a stream object for Morgan
const stream = {
    write: (message) => {
        logger.info(message.trim());
    }
};

// Log unhandled rejections
process.on('unhandledRejection', (error) => {
    logger.error('Unhandled Rejection:', { error: error.message, stack: error.stack });
});

// Log, do not exit. src/mcp/start.js installs a deliberate survive-and-log handler; node runs
// every registered handler, so an exit(1) here won the race and closed the editor's pipe with no
// JSON-RPC error frame and no explanation. tool-handlers.js requires blast-radius — and so this
// logger — for EVERY tool, so one stray async throw anywhere ended the session. Whoever owns the
// process decides whether to exit.
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
});

module.exports = {
    logger,
    stream
}; 