/**
 * missing/not-found.tsx — 自定义 404 UI
 *
 * 文件位置：src/app/missing/not-found.tsx
 *
 * 触发时机
 * ─────────────────────────────────────────────────────────────────
 * 以下两种情况会渲染 not-found.tsx：
 *
 *   1. 代码主动调用 notFound()（来自 next/navigation）。
 *      典型场景：按 ID 查询数据库，结果为 null/undefined，
 *      资源确实不存在，应该告知用户"找不到"，而不是抛出 500 错误。
 *
 *   2. 用户访问了一个完全不存在的 URL（如 /some/path/that/has/no/page）。
 *      Next.js 会向上寻找最近的 not-found.tsx 并渲染。
 *      若没有找到任何自定义的，则使用 Next.js 内置的默认 404 页。
 *
 * 与 error.tsx 的区别
 * ─────────────────────────────────────────────────────────────────
 *   • notFound() + not-found.tsx → "找不到资源"，HTTP 状态码 404，属于正常业务情况。
 *   • throw Error + error.tsx    → "发生了错误"，HTTP 状态码 500，属于异常情况。
 *   切勿混用：资源不存在应该用 notFound()，而不是 throw。
 *
 * 这是一个服务端组件，无需 "use client"。
 * （not-found.tsx 不需要像 error.tsx 那样必须是客户端组件。）
 */

import Link from "next/link";

export default function NotFoundPage() {
  return (
    <div>
      <h1>404 演示页</h1>

      {/* 主要内容 */}
      <div
        className="demo-box"
        style={{ textAlign: "center", padding: "48px 24px" }}
      >
        {/* 大号图标 */}
        <div style={{ fontSize: "64px", lineHeight: 1, marginBottom: "16px" }}>
          🔍
        </div>

        {/* 标题 */}
        <h2 style={{ margin: "0 0 12px", fontSize: "22px" }}>
          找不到这个资源（404）
        </h2>

        {/* 说明 */}
        <p className="muted" style={{ maxWidth: "420px", margin: "0 auto 24px" }}>
          你看到这个页面，是因为同级的 <code>missing/page.tsx</code> 调用了{" "}
          <code>notFound()</code>。Next.js 找到了最近的{" "}
          <code>not-found.tsx</code>（即此文件）并渲染它。
        </p>

        {/* HTTP 状态码提示 */}
        <p className="muted" style={{ fontSize: "13px", margin: "0 0 28px" }}>
          HTTP 响应状态码为 <strong style={{ color: "#e6e9ef" }}>404 Not Found</strong>
        </p>

        {/* 返回链接 */}
        <Link href="/" className="btn">
          ← 返回第 07 章概览
        </Link>
      </div>

      {/* 说明卡片 */}
      <div className="card" style={{ marginTop: "24px" }}>
        <h2 style={{ marginTop: 0 }}>什么时候用 notFound()？</h2>
        <p>当你按某个标识符（ID、slug 等）查找资源，结果为空时，应该调用 notFound()：</p>
        <pre>{`// 典型场景：按 ID 查询文章
export default async function ArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const article = await db.articles.findById(id);

  // 文章不存在 → 渲染 not-found.tsx，而不是 throw Error
  if (!article) {
    notFound();
  }

  return <div>{article.title}</div>;
}`}</pre>
        <p className="muted" style={{ fontSize: "13px", marginBottom: 0 }}>
          <strong>关键区别：</strong>
          资源不存在（404）用 <code>notFound()</code>；
          发生了意外错误（500）用 <code>throw new Error(...)</code>。
          语义正确，HTTP 状态码也正确。
        </p>
      </div>
    </div>
  );
}
