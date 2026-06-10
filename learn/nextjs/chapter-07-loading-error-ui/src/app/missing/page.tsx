/**
 * missing/page.tsx — 调用 notFound() 触发 404 UI 的服务端组件
 *
 * 文件位置：src/app/missing/page.tsx
 * 访问 URL ：/missing
 *
 * 核心演示：not-found.tsx 的触发机制
 * ─────────────────────────────────────────────────────────────────
 * notFound() 是 next/navigation 提供的一个函数。调用它会：
 *   1. 立即中止当前组件的渲染（类似 throw，但语义不同）。
 *   2. 将 HTTP 响应状态码设为 404。
 *   3. 让 Next.js 寻找最近的同级 not-found.tsx 并渲染。
 *
 * 与 throw new Error(...) 的重要区别
 * ─────────────────────────────────────────────────────────────────
 * • notFound()         → 语义：资源不存在。触发 not-found.tsx，状态码 404。
 * • throw new Error()  → 语义：发生了意外错误。触发 error.tsx，状态码 500。
 *
 * 在真实项目中，按 ID 查找数据库后结果为 null，应该用 notFound()，
 * 而不是 throw Error，因为"找不到"是业务的正常情况，不是程序错误。
 *
 * 典型真实场景：
 *   const post = await db.posts.findById(params.id);
 *   if (!post) {
 *     notFound(); // 文章不存在，渲染 not-found.tsx
 *   }
 *   return <PostDetail post={post} />;
 *
 * 这是一个服务端组件，无需 "use client"。
 */

// notFound 是 next/navigation 提供的工具函数，专门用于触发 404 响应。
import { notFound } from "next/navigation";

export default function MissingPage() {
  /*
   * 在这里调用 notFound()。
   *
   * 真实场景的等价代码：
   *   const item = await fetchItemById(id);
   *   if (!item) {
   *     notFound(); // 数据不存在时才调用
   *   }
   *
   * 这里直接调用，是为了演示目的——模拟「每次查询结果都为空」。
   */
  notFound();

  // notFound() 之后的代码永远不会执行。
  // TypeScript 可以推断出这点（notFound() 的返回类型是 never）。
  // 无需写 return 语句。
}
