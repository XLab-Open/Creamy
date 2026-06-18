/**
 * broken/page.tsx — 故意抛出错误的服务端组件
 *
 * 文件位置：src/app/broken/page.tsx
 * 访问 URL ：/broken
 *
 * 核心演示：error.tsx 的触发机制
 * ─────────────────────────────────────────────────────────────────
 * 这个组件在渲染时会直接 throw new Error(...)，模拟真实场景中可能发生的错误。
 *
 * 真实场景里，错误可能来自：
 *   • fetch('/api/xxx') 返回非 2xx 状态码，并手动 throw
 *   • await db.query(...) 数据库连接失败
 *   • 解构 null 或 undefined 对象（运行时 TypeError）
 *   • 第三方 SDK 内部抛出的错误
 *   • 业务逻辑检验失败（如必要配置缺失）
 *
 * 当 throw 发生时，Next.js 会：
 *   1. 中止该组件的渲染。
 *   2. 寻找最近的同级 error.tsx（即 broken/error.tsx）。
 *   3. 把错误信息传递给 error.tsx 的 error prop，并渲染该组件。
 *   4. 页面其余部分（如 layout、导航栏）保持正常，只有出错的「路由段」被替换。
 *
 * 注意：这是一个服务端组件，无需 "use client"。
 * error.tsx 必须是客户端组件，但 page.tsx 本身仍然可以是（且通常应该是）服务端组件。
 */

// ⚠️ 强制此路由「动态渲染」（按请求渲染），而不是在构建期静态预渲染。
// 因为本页总是 throw：若让它在 `next build` 时被静态预渲染，会直接让整个构建失败。
// 设为 force-dynamic 后，错误只会在用户真正访问时发生，从而正常触发 error.tsx。
// （这也顺带演示了第 05 章提到的「静态 vs 动态渲染」开关。）
export const dynamic = "force-dynamic";

// 这个函数永远不会返回——它总是会 throw，从而触发同级的 error.tsx。
// 在真实代码里，你当然不会故意 throw，但这里是为了演示目的。
export default function BrokenPage() {
  /*
   * 直接在渲染函数体里 throw。
   *
   * 真实场景的等价代码示例：
   *   const res = await fetch('/api/data');
   *   if (!res.ok) throw new Error(`API 请求失败：${res.status}`);
   *
   * 或者：
   *   const user = await db.users.findById(id);
   *   if (!user) notFound(); // 资源不存在用 notFound()，不是 throw
   *   if (!user.isActive) throw new Error('账户已被禁用');
   */
  throw new Error("演示用：这是一个故意抛出的错误");

  // 以下代码永远不会被执行（TypeScript 可以推断出这点）。
  // Next.js 会在 throw 之后立即寻找 error.tsx 并渲染它。
  return null;
}
