// 统一日志：所有输出带 [lwe] 前缀，方便 journalctl 过滤
const PREFIX = '[lwe]';

/**
 * @param {string} scope 模块名，会拼在前缀后面，例如 [lwe:renderer]
 */
export function createLogger(scope = '') {
    const tag = scope ? `${PREFIX}:${scope}` : PREFIX;
    return {
        info(...args) {
            console.log(tag, ...args);
        },
        warn(...args) {
            console.warn(tag, ...args);
        },
        error(...args) {
            console.error(tag, ...args);
        },
    };
}
