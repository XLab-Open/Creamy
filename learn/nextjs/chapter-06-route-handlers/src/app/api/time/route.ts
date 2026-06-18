/**
 * 第 06 章 · 最简路由处理程序示例：/api/time
 *
 * 这是一个只读接口，每次 GET 请求都返回当前服务器时间。
 * 用途：演示「动态接口」——每次调用结果都不同，不能被静态缓存。
 *
 * 关于缓存行为（重要！）：
 *   - Next.js 15 中，GET 路由处理程序**默认不缓存**（与 Next.js 14 行为不同）。
 *   - 若需要在旧版本或某些部署环境中明确告知「每次请求都动态执行」，
 *     可以导出以下常量强制动态模式：
 *       export const dynamic = 'force-dynamic';
 *   - 反之，如果接口返回的数据是静态的，可用：
 *       export const revalidate = 60; // 60 秒重新验证一次
 */

// 明确声明为动态模式，确保每次请求都重新执行，不使用缓存
// 对于返回当前时间这类数据，这是必须的
export const dynamic = "force-dynamic";

/**
 * GET /api/time
 *
 * 返回当前服务端时间，是最简单的路由处理程序示例。
 * 没有参数读取，没有请求体解析，只是 new Date() 然后返回。
 *
 * 实际应用场景：
 *   - 健康检查（health check）接口
 *   - 服务器时钟同步
 *   - 演示「动态数据源」与「静态数据」的对比
 */
export async function GET() {
  // new Date().toISOString() 返回类似 "2024-01-15T08:30:00.000Z" 的字符串
  // 这是 UTC 时间的 ISO 8601 格式，跨时区兼容性最好
  const now = new Date();

  return Response.json({
    now: now.toISOString(),
    // 同时提供本地可读格式，方便中文用户直观查看
    localString: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    timezone: "Asia/Shanghai (UTC+8)",
    hint: "每次调用此接口都会返回最新时间，因为 dynamic = 'force-dynamic'",
  });
}
