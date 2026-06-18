/**
 * slow/page.tsx — 模拟慢加载的 async 服务端组件
 *
 * 文件位置：src/app/slow/page.tsx
 * 访问 URL ：/slow
 *
 * 核心演示：loading.tsx 的触发机制
 * ─────────────────────────────────────────────────────────────────
 * 当这个 async 函数组件执行到 await 并「挂起」时，Next.js（通过 React Suspense）
 * 会立即把 loading.tsx 的内容推送给浏览器显示，同时在服务器后台继续等待。
 * await 结束后，真实的页面内容会流式地替换掉加载占位符。
 *
 * 这整个过程对开发者完全透明——你只需要：
 *   1. 把 page.tsx 声明为 async 函数。
 *   2. 在函数体里 await 任何耗时操作（fetch、数据库查询等）。
 *   3. 在同级放一个 loading.tsx。
 * 剩下的工作由 Next.js + React Suspense 自动完成。
 *
 * 刷新此页即可观察效果：
 *   浏览器 → 立刻显示 loading.tsx（"⏳ 正在加载…"）
 *   ~1.5s 后 → 本页面真实内容流式替换
 */

import Link from "next/link";

/**
 * 模拟耗时操作的辅助函数。
 * 真实场景里这里会是：fetch('/api/data')、db.query(...)、fs.readFile(...) 等。
 */
async function simulateSlowFetch(): Promise<{ message: string; timestamp: string }> {
  // 等待 1500 毫秒，模拟网络请求或数据库查询的延迟。
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  return {
    message: "数据加载完成！这条内容是 async page.tsx 在服务端 await 之后渲染的。",
    timestamp: new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

// async 函数组件——这是让 loading.tsx 生效的关键。
// Next.js 会检测到这个组件是 async 且在等待，自动触发 Suspense 边界。
export default async function SlowPage() {
  // 这一行 await 会让组件「挂起」约 1.5 秒。
  // 挂起期间，同级的 loading.tsx 被自动显示给用户。
  const data = await simulateSlowFetch();

  // await 完成后，以下 JSX 流式推送给浏览器，替换掉 loading.tsx 的内容。
  return (
    <div>
      <h1>慢加载演示页</h1>

      <p>
        你现在看到的是 <code>slow/page.tsx</code> 渲染完成后的真实内容。
        如果你看到了这里的文字，说明 1.5 秒的等待已经结束。
      </p>

      {/* 结果展示区 */}
      <div className="demo-box" style={{ marginTop: "24px" }}>
        <p style={{ margin: "0 0 8px", color: "#6ea8fe", fontWeight: 600 }}>
          ✅ 异步数据加载成功
        </p>
        <p style={{ margin: "0 0 4px" }}>{data.message}</p>
        <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
          服务端渲染时间：{data.timestamp}
        </p>
      </div>

      {/* 原理说明 */}
      <div className="card" style={{ marginTop: "24px" }}>
        <h2 style={{ marginTop: 0 }}>发生了什么？</h2>
        <ol style={{ paddingLeft: "20px", lineHeight: "2" }}>
          <li>
            浏览器请求 <code>/slow</code>。
          </li>
          <li>
            Next.js 检测到 <code>page.tsx</code> 是 async 组件，把它包裹在{" "}
            <code>{"<Suspense>"}</code> 中，<code>loading.tsx</code> 作为 fallback。
          </li>
          <li>
            浏览器立即收到包含 <code>loading.tsx</code> 内容的 HTML（「⏳ 正在加载…」）。
          </li>
          <li>
            服务端后台执行 <code>await simulateSlowFetch()</code>（等待 1.5 秒）。
          </li>
          <li>
            await 完成后，本页面的真实 HTML 通过流式传输（Streaming）替换掉占位内容。
          </li>
        </ol>
      </div>

      {/* 代码示例 */}
      <h2>关键代码结构</h2>
      <pre>{`// slow/page.tsx
export default async function SlowPage() {
  // await 任何耗时操作
  const data = await fetchFromDatabase();
  return <div>{data}</div>;
}

// slow/loading.tsx（同级）
export default function Loading() {
  return <p>⏳ 正在加载…</p>;
}
// 无需任何额外配置，Next.js 自动关联两者。`}</pre>

      {/* 返回链接 */}
      <div style={{ marginTop: "32px" }}>
        <Link href="/" className="btn">
          ← 返回第 07 章概览
        </Link>
      </div>
    </div>
  );
}
