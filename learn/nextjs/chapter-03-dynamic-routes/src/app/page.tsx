/**
 * 第 03 章概览页（根路由）
 *
 * 路由：/
 * 文件：src/app/page.tsx
 *
 * 本页是服务端组件（Server Component）——无需任何标注，App Router 的默认行为。
 * 概览页不需要动态参数，所以是一个普通（非 async）组件也完全可以。
 */

import Link from "next/link";

export default function HomePage() {
  return (
    <div>
      {/* ── 标题 ─────────────────────────────────────────────────── */}
      <h1>第 03 章 · 动态路由与路由组</h1>
      <p className="muted">
        本章讲解 Next.js App Router 的动态路由机制：
        用方括号命名文件夹来匹配任意 URL 段，
        以及用圆括号对路由进行逻辑分组而不影响 URL。
      </p>

      {/* ── 核心概念速览 ─────────────────────────────────────────── */}
      <div className="card">
        <h2>核心概念速览</h2>

        {/* 1. 动态段 [id] */}
        <section style={{ marginBottom: "24px" }}>
          <h3>
            <span className="tag">[id]</span> 动态段（Dynamic Segment）
          </h3>
          <p>
            把文件夹命名为 <code>[id]</code>（方括号包裹），
            Next.js 就会把该位置的 URL 片段作为参数传给页面组件。
          </p>
          <p>
            例如路由 <code>/products/[id]</code> 会同时匹配：
          </p>
          <ul>
            <li>
              <code>/products/1</code> → <code>id = "1"</code>
            </li>
            <li>
              <code>/products/42</code> → <code>id = "42"</code>
            </li>
            <li>
              <code>/products/abc</code> → <code>id = "abc"</code>
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "13px" }}>
            ⚠️ Next.js 15 重大变化：页面组件收到的 <code>params</code> 是一个{" "}
            <strong>Promise</strong>，必须将组件声明为 <code>async</code>{" "}
            并用 <code>await params</code> 取出实际值。
          </p>
        </section>

        {/* 2. catch-all [...slug] */}
        <section style={{ marginBottom: "24px" }}>
          <h3>
            <span className="tag">[...slug]</span> Catch-all 段
          </h3>
          <p>
            三个点 <code>...</code> 让这个段可以匹配任意数量的 URL 片段，
            收到的值是 <code>string[]</code>。
          </p>
          <ul>
            <li>
              <code>/docs/guide/intro</code> → <code>slug = ["guide", "intro"]</code>
            </li>
            <li>
              <code>/docs/a/b/c</code> → <code>slug = ["a", "b", "c"]</code>
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "13px" }}>
            注意：<code>[...slug]</code> 不匹配 <code>/docs</code>
            本身（没有任何片段时不匹配）。
          </p>
        </section>

        {/* 3. 可选 catch-all [[...slug]] */}
        <section style={{ marginBottom: "24px" }}>
          <h3>
            <span className="tag">{"[[...slug]]"}</span> 可选 Catch-all 段
          </h3>
          <p>
            双层方括号让该段变为「可选」：即使 URL 中没有任何片段，路由也能匹配，
            此时 <code>slug</code> 为 <code>undefined</code>。
          </p>
          <ul>
            <li>
              <code>/shop</code> → <code>slug = undefined</code>（匹配成功）
            </li>
            <li>
              <code>/shop/clothes/tops</code> → <code>slug = ["clothes", "tops"]</code>
            </li>
          </ul>
        </section>

        {/* 4. 路由组 (group) */}
        <section style={{ marginBottom: "24px" }}>
          <h3>
            <span className="tag">(group)</span> 路由组（Route Group）
          </h3>
          <p>
            把文件夹名用圆括号包裹，例如 <code>(marketing)</code>，
            Next.js 会忽略这一层目录——它<strong>不会出现在 URL 中</strong>，
            仅用于在文件系统里对路由进行逻辑分组，方便共享 layout 或管理代码。
          </p>
          <p>例如：</p>
          <ul>
            <li>
              <code>app/(marketing)/about/page.tsx</code> → URL 是 <code>/about</code>
            </li>
            <li>
              <code>app/(shop)/products/page.tsx</code> → URL 是 <code>/products</code>
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "13px" }}>
            两组路由可以分别拥有自己的 <code>layout.tsx</code>，互不干扰。
          </p>
        </section>

        {/* 5. generateStaticParams */}
        <section>
          <h3>
            <span className="tag">generateStaticParams</span> 静态预渲染
          </h3>
          <p>
            在动态路由页面中导出 <code>generateStaticParams</code> 函数，
            Next.js 会在构建期（<em>build time</em>）将指定的参数组合预先渲染为静态 HTML，
            实现零运行时延迟的 SSG（静态站点生成）。
          </p>
          <pre
            style={{
              background: "rgba(0,0,0,0.3)",
              borderRadius: "6px",
              padding: "12px",
              fontSize: "13px",
              overflowX: "auto",
            }}
          >{`// 在 products/[id]/page.tsx 中导出此函数
export function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
}`}</pre>
        </section>
      </div>

      {/* ── 示例链接 ─────────────────────────────────────────────── */}
      <div className="card">
        <h2>动手体验</h2>
        <p className="muted">点击下方链接，观察不同动态路由的行为：</p>

        <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>
          动态段 <code>[id]</code> 示例
        </h3>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "20px" }}>
          {/*
           * 使用绝对路径确保正确跳转。
           * 对应路由：src/app/products/[id]/page.tsx
           */}
          <Link className="btn" href="/products/1">
            产品 #1
          </Link>
          <Link className="btn" href="/products/2">
            产品 #2
          </Link>
          <Link className="btn" href="/products/3">
            产品 #3
          </Link>
          <Link className="btn" href="/products/999">
            产品 #999（不存在）
          </Link>
        </div>

        <h3 style={{ fontSize: "15px", marginBottom: "8px" }}>
          Catch-all <code>[...slug]</code> 示例
        </h3>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {/*
           * 对应路由：src/app/docs/[...slug]/page.tsx
           * /docs/guide/intro → slug = ["guide", "intro"]
           * /docs/a/b/c      → slug = ["a", "b", "c"]
           */}
          <Link className="btn" href="/docs/guide/intro">
            /docs/guide/intro
          </Link>
          <Link className="btn" href="/docs/a/b/c">
            /docs/a/b/c
          </Link>
          <Link className="btn" href="/docs/single">
            /docs/single
          </Link>
        </div>
      </div>

      {/* ── 本章小结 ─────────────────────────────────────────────── */}
      <div className="card">
        <h2>本章小结</h2>
        <ul>
          <li>
            <strong>[id]</strong> —— 单个动态段，匹配一个 URL 片段，params 中对应字段为
            <code>string</code>。
          </li>
          <li>
            <strong>[...slug]</strong> —— catch-all 段，匹配一个或多个片段，
            params.slug 类型为 <code>string[]</code>。
          </li>
          <li>
            <strong>{"[[...slug]]"}</strong> —— 可选 catch-all，连零片段也能匹配，
            slug 为 <code>undefined | string[]</code>。
          </li>
          <li>
            <strong>(group)</strong> —— 路由组，仅组织文件，不影响 URL。
          </li>
          <li>
            <strong>generateStaticParams</strong> —— 在构建期枚举所有需要预渲染的参数，
            生成静态页面（SSG）。
          </li>
          <li>
            <strong>Next.js 15 重点</strong>：<code>params</code> 和{" "}
            <code>searchParams</code> 均为 <strong>Promise</strong>，
            必须在 <code>async</code> 组件中 <code>await</code>。
          </li>
        </ul>
      </div>
    </div>
  );
}
