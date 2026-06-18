"use client";
/**
 * 第 06 章 · 路由处理程序 (API Routes) — 演示页面
 *
 * 这是一个**客户端组件**（首行 "use client" 声明）。
 * 原因：需要用 useState 存储接口响应、用 fetch 发起网络请求，
 * 这些都是客户端运行时行为，不能在服务端组件中直接使用。
 *
 * 页面演示三个接口：
 *   1. GET /api/hello?name=...   （带查询参数）
 *   2. POST /api/hello           （带 JSON 请求体）
 *   3. GET /api/time             （无参数，获取服务器时间）
 */

import { useState } from "react";

// ─── 类型定义 ──────────────────────────────────────────────────────────────────
// 用 unknown 接收 JSON 响应，比 any 更安全；显示时再用 JSON.stringify
type FetchState = {
  loading: boolean;
  data: unknown;
  error: string | null;
};

/** 初始状态：尚未发起请求 */
const INITIAL_STATE: FetchState = { loading: false, data: null, error: null };

// ─── 主组件 ───────────────────────────────────────────────────────────────────
export default function Chapter06Page() {
  // ── 状态：三个接口各自独立，互不干扰 ──────────────────────────────────────
  const [getResult, setGetResult] = useState<FetchState>(INITIAL_STATE);
  const [postResult, setPostResult] = useState<FetchState>(INITIAL_STATE);
  const [timeResult, setTimeResult] = useState<FetchState>(INITIAL_STATE);

  // ── name 输入框的受控值 ────────────────────────────────────────────────────
  const [name, setName] = useState("学习者");

  // POST 请求体的受控输入
  const [postBody, setPostBody] = useState('{"greeting":"你好","from":"前端"}');

  // ─── 事件处理：调用 GET /api/hello ─────────────────────────────────────────
  async function handleGetHello() {
    // 1. 进入加载状态，清空上次结果
    setGetResult({ loading: true, data: null, error: null });

    try {
      // 2. 用绝对路径构造 URL，带上 name 查询参数
      //    encodeURIComponent 确保中文/特殊字符被正确编码，避免 URL 解析错误
      const url = `/api/hello?name=${encodeURIComponent(name)}`;

      // 3. 发起 GET 请求（fetch 默认就是 GET，无需额外配置）
      const res = await fetch(url);

      // 4. 检查 HTTP 状态码；4xx/5xx 时 res.ok 为 false
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // 5. 解析 JSON 响应体
      const json: unknown = await res.json();

      // 6. 更新状态，触发重渲染
      setGetResult({ loading: false, data: json, error: null });
    } catch (err) {
      // 7. 捕获网络错误或解析错误
      setGetResult({
        loading: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 事件处理：调用 POST /api/hello ────────────────────────────────────────
  async function handlePostHello() {
    setPostResult({ loading: true, data: null, error: null });

    try {
      // 1. 先尝试解析用户输入的 JSON 字符串，验证格式正确
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(postBody);
      } catch {
        throw new Error("请求体不是合法 JSON，请检查输入格式");
      }

      // 2. 发起 POST 请求
      //    必须设置 method: 'POST' 和 Content-Type 头
      //    body 必须是字符串（JSON.stringify 转换）
      const res = await fetch("/api/hello", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", // 告知服务端请求体是 JSON
        },
        body: JSON.stringify(parsedBody), // 序列化为 JSON 字符串
      });

      if (!res.ok) {
        const errJson: unknown = await res.json().catch(() => ({}));
        throw new Error(
          `HTTP ${res.status}: ${JSON.stringify(errJson)}`
        );
      }

      const json: unknown = await res.json();
      setPostResult({ loading: false, data: json, error: null });
    } catch (err) {
      setPostResult({
        loading: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 事件处理：获取服务器时间 ──────────────────────────────────────────────
  async function handleGetTime() {
    setTimeResult({ loading: true, data: null, error: null });

    try {
      // GET /api/time，无需任何参数
      const res = await fetch("/api/time");

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json: unknown = await res.json();
      setTimeResult({ loading: false, data: json, error: null });
    } catch (err) {
      setTimeResult({
        loading: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 渲染结果块的辅助组件（内联定义，仅本页使用）─────────────────────────
  function ResultBox({ state, label }: { state: FetchState; label: string }) {
    return (
      <div className="demo-box" style={{ marginTop: 12 }}>
        <div className="muted" style={{ marginBottom: 6, fontSize: 13 }}>
          {label}
        </div>
        {state.loading && (
          <span className="muted">正在请求…</span>
        )}
        {state.error && (
          <span style={{ color: "#f87171" }}>错误：{state.error}</span>
        )}
        {!state.loading && !state.error && state.data !== null && (
          // JSON.stringify 第三个参数 2 = 缩进 2 个空格，输出易读的格式
          <pre style={{ margin: 0 }}>
            <code>{JSON.stringify(state.data, null, 2)}</code>
          </pre>
        )}
        {!state.loading && !state.error && state.data === null && (
          <span className="muted">（点击按钮后结果显示在这里）</span>
        )}
      </div>
    );
  }

  // ─── JSX ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* 章节标题 */}
      <h1>第 06 章 · 路由处理程序 (API Routes)</h1>
      <p className="muted">
        App Router 使用 <code>route.ts</code> 定义 HTTP 接口。导出与 HTTP
        方法同名的函数（<code>GET</code>、<code>POST</code> 等），
        Next.js 会自动把对应方法的请求路由到该函数。
        本章通过三个可交互的示例演示如何编写和调用这些接口。
      </p>

      {/* ── 示例一：GET 带查询参数 ─────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          示例一：GET 请求 + 查询参数（search params）
        </h2>
        <p className="muted">
          接口位于 <code>/api/hello</code>。
          服务端通过 <code>new URL(request.url).searchParams.get(&apos;name&apos;)</code>{" "}
          读取 <code>name</code> 参数，返回问候语和服务器时间。
        </p>

        {/* name 输入框 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="name-input" style={{ whiteSpace: "nowrap" }}>
            name 参数：
          </label>
          <input
            id="name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入名字，例如：张三"
            style={{
              flex: 1,
              minWidth: 160,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--panel)",
              color: "var(--text)",
              fontSize: 14,
            }}
          />
          {/* 点击后调用 GET /api/hello?name=... */}
          <button className="btn" onClick={handleGetHello}>
            调用 GET /api/hello
          </button>
        </div>

        <ResultBox state={getResult} label="GET 响应结果" />
      </div>

      {/* ── 示例二：POST 带请求体 ──────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          示例二：POST 请求 + JSON 请求体（request body）
        </h2>
        <p className="muted">
          同一个接口 <code>/api/hello</code>，
          但用 POST 方法。服务端通过 <code>await request.json()</code>{" "}
          读取请求体，并将其原样回显（echo）回来。
        </p>

        {/* POST 请求体输入框 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="post-body" style={{ fontSize: 14 }}>
            请求体（JSON 格式）：
          </label>
          <textarea
            id="post-body"
            value={postBody}
            onChange={(e) => setPostBody(e.target.value)}
            rows={3}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--panel)",
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "ui-monospace, Menlo, Consolas, monospace",
              resize: "vertical",
            }}
          />
          <button className="btn" onClick={handlePostHello} style={{ alignSelf: "flex-start" }}>
            调用 POST /api/hello
          </button>
        </div>

        <ResultBox state={postResult} label="POST 响应结果" />
      </div>

      {/* ── 示例三：获取服务器时间 ─────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          示例三：最简接口 — 获取服务器时间
        </h2>
        <p className="muted">
          接口位于 <code>/api/time</code>。
          它不需要任何参数，每次调用都返回当前服务器时间。
          该接口声明了 <code>export const dynamic = &apos;force-dynamic&apos;</code>，
          确保每次请求都重新执行而不使用缓存。
        </p>

        <button className="btn" onClick={handleGetTime}>
          获取服务器时间
        </button>

        <ResultBox state={timeResult} label="时间接口响应结果" />
      </div>

      {/* ── 关键代码速查 ───────────────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>关键代码速查</h2>

        <p>
          <span className="tag">route.ts</span> 文件放在任意路由段下，命名必须是{" "}
          <code>route.ts</code>（不是 <code>page.tsx</code>）：
        </p>
        <pre>
          <code>{`// app/api/hello/route.ts

// GET：读取查询参数
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name') ?? '世界';
  return Response.json({ message: \`你好，\${name}！\` });
}

// POST：读取请求体
export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({ youSent: body });
}`}</code>
        </pre>

        <p style={{ marginTop: 16 }}>
          <span className="tag">客户端调用</span>
        </p>
        <pre>
          <code>{`// GET 带查询参数
const res = await fetch('/api/hello?name=张三');
const data = await res.json();

// POST 带请求体
const res = await fetch('/api/hello', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
});
const data = await res.json();`}</code>
        </pre>
      </div>

      {/* ── 本章小结 ───────────────────────────────────────────────────────── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
          <li>
            <strong>route.ts 定义接口</strong>：App Router 中创建 HTTP 接口的文件名固定为{" "}
            <code>route.ts</code>，不是 <code>page.tsx</code>。
          </li>
          <li>
            <strong>方法名即导出函数名</strong>：<code>GET</code>、<code>POST</code>、
            <code>PUT</code>、<code>DELETE</code> 等，全部大写，按需导出。
          </li>
          <li>
            <strong>读取查询参数</strong>：<code>new URL(request.url).searchParams.get(&apos;key&apos;)</code>。
          </li>
          <li>
            <strong>读取请求体</strong>：<code>await request.json()</code>（异步，需 await）。
          </li>
          <li>
            <strong>返回 JSON</strong>：<code>Response.json(data)</code> 或{" "}
            <code>NextResponse.json(data)</code>，两者等效，前者是 Web 标准 API。
          </li>
          <li>
            <strong>动态模式</strong>：若接口结果每次都不同，加{" "}
            <code>export const dynamic = &apos;force-dynamic&apos;</code> 防止缓存。
          </li>
          <li>
            <strong>目录互斥</strong>：<code>route.ts</code> 和 <code>page.tsx</code>{" "}
            不能在同一目录下共存，通常把接口放在 <code>api/</code> 子目录下。
          </li>
        </ul>
      </div>
    </div>
  );
}
