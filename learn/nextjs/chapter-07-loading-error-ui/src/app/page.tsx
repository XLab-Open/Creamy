/**
 * 第 07 章 · 概览页 (Overview Page)
 *
 * 文件位置：src/app/page.tsx
 * 访问 URL ：/
 *
 * 这是一个「服务端组件」（Server Component），默认如此，无需任何声明。
 *
 * 本章介绍 App Router 中三个处理「加载态、错误态和 404」的特殊文件：
 *   • loading.tsx   — 基于 Suspense 的自动加载骨架
 *   • error.tsx     — 渲染期错误捕获（必须是客户端组件）
 *   • not-found.tsx — 404 自定义 UI（由 notFound() 触发）
 */

import Link from "next/link";

export default function Chapter07OverviewPage() {
  return (
    <div>
      {/* ── 章节标题 ────────────────────────────────────────────── */}
      <h1>第 07 章 · 加载、错误与 404 UI</h1>

      <p>
        在 Next.js App Router 中，除了 <code>page.tsx</code> 和{" "}
        <code>layout.tsx</code>，还有几个「特殊约定文件」专门处理不同状态下的 UI
        呈现。本章聚焦三个最常用的：
      </p>

      <ul>
        <li>
          <code>loading.tsx</code> — 页面数据加载期间的占位 UI，基于 React Suspense 自动工作。
        </li>
        <li>
          <code>error.tsx</code> — 捕获该路由段渲染过程中抛出的错误，必须是客户端组件。
        </li>
        <li>
          <code>not-found.tsx</code> — 当调用 <code>notFound()</code> 或访问不存在路由时显示的 404 UI。
        </li>
      </ul>

      {/* ── 三个演示入口 ─────────────────────────────────────────── */}
      <h2>三个交互演示</h2>

      <p>点击下方任意一项，亲眼看到对应特殊文件如何生效：</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginTop: "20px" }}>

        {/* 演示 1：loading.tsx */}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <span className="tag">loading.tsx</span>
          </p>
          <h3 style={{ margin: "8px 0" }}>慢加载演示</h3>
          <p className="muted" style={{ fontSize: "14px" }}>
            访问该页面时，<code>page.tsx</code> 内部会等待 1.5 秒（模拟取数）。
            在等待期间，Next.js 自动渲染同级的 <code>loading.tsx</code> 作为占位符。
          </p>
          <p className="muted" style={{ fontSize: "14px" }}>
            你会先看到「⏳ 正在加载…」，约 1.5 秒后内容出现。
          </p>
          <Link
            href="/slow"
            className="btn"
            style={{ display: "inline-block", marginTop: "8px" }}
          >
            前往慢加载页 →
          </Link>
        </div>

        {/* 演示 2：error.tsx */}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <span className="tag">error.tsx</span>
          </p>
          <h3 style={{ margin: "8px 0" }}>错误边界演示</h3>
          <p className="muted" style={{ fontSize: "14px" }}>
            该页面的 <code>page.tsx</code> 在渲染时会直接 <code>throw new Error(...)</code>。
            Next.js 捕获这个错误，并渲染同级的 <code>error.tsx</code>。
          </p>
          <p className="muted" style={{ fontSize: "14px" }}>
            你会看到错误信息和一个「重试」按钮，点击重试可以重新尝试渲染。
          </p>
          <Link
            href="/broken"
            className="btn"
            style={{ display: "inline-block", marginTop: "8px" }}
          >
            前往错误页 →
          </Link>
        </div>

        {/* 演示 3：not-found.tsx */}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <span className="tag">not-found.tsx</span>
          </p>
          <h3 style={{ margin: "8px 0" }}>404 演示</h3>
          <p className="muted" style={{ fontSize: "14px" }}>
            该页面的 <code>page.tsx</code> 会调用 <code>notFound()</code>（来自{" "}
            <code>next/navigation</code>），模拟「按 ID 查询结果为空」的场景。
          </p>
          <p className="muted" style={{ fontSize: "14px" }}>
            你会看到自定义的 404 UI，而不是浏览器默认的错误页。
          </p>
          <Link
            href="/missing"
            className="btn"
            style={{ display: "inline-block", marginTop: "8px" }}
          >
            前往 404 页 →
          </Link>
        </div>
      </div>

      {/* ── 文件层级说明 ─────────────────────────────────────────── */}
      <h2>文件结构一览</h2>

      <p>本章在 <code>src/app/</code> 下创建了以下文件：</p>

      <pre>{`src/app/
├── page.tsx                ← 你现在看到的这个概览页
│
├── slow/
│   ├── loading.tsx         ← 加载态占位 UI（自动显示）
│   └── page.tsx            ← async 服务端组件，await 1.5s 后渲染
│
├── broken/
│   ├── error.tsx           ← 错误边界（"use client" 客户端组件）
│   └── page.tsx            ← 渲染时 throw new Error(...)
│
└── missing/
    ├── not-found.tsx       ← 自定义 404 UI
    └── page.tsx            ← 渲染时调用 notFound()`}</pre>

      <p className="muted" style={{ fontSize: "14px" }}>
        关键规律：这些特殊文件与 <code>page.tsx</code> 同级放置，Next.js 会自动在适当时机显示它们，
        无需在 <code>page.tsx</code> 中手动引用。
      </p>

      {/* ── 本章小结 ────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: "40px" }}>
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul>
          <li>
            <strong>loading.tsx：</strong>与 <code>page.tsx</code> 同级，当 async page
            挂起时自动显示；本质是 Next.js 自动把 page 包裹在 <code>{"<Suspense>"}</code> 里。
          </li>
          <li>
            <strong>error.tsx：</strong>捕获该路由段渲染期间的错误；
            <em>必须是客户端组件</em>（加 <code>"use client"</code>）；
            接收 <code>error</code>（错误对象）和 <code>reset</code>（重试函数）两个 props。
          </li>
          <li>
            <strong>not-found.tsx：</strong>在代码中调用 <code>notFound()</code>（如查数据库返回 null 时），
            Next.js 会渲染最近的 <code>not-found.tsx</code>，而不是抛出错误。
          </li>
          <li>
            <strong>就近原则：</strong>这些特殊文件只影响同级及其子页面，不同路由段可以有各自独立的
            <code>loading</code>/<code>error</code>/<code>not-found</code>。
          </li>
        </ul>
      </div>
    </div>
  );
}
