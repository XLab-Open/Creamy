/**
 * page.tsx — 第 08 章根路由页面：Server Actions 与表单提交
 *
 * 这是一个「async 服务端组件」（默认，无需任何标记）：
 * - 可以直接 await 异步函数，无需 useEffect / useState。
 * - 在服务器上渲染，结果作为 HTML 发送到浏览器。
 * - 每当 revalidatePath 触发后，Next.js 会重新执行此函数，
 *   获取最新数据并生成新的 HTML——这就是数据刷新的完整链路：
 *
 *   用户填写留言 → <form action={formAction}> 提交
 *     → Server Action (addMessage) 在服务器执行
 *     → messages 数组追加新留言
 *     → revalidatePath('/') 使缓存失效
 *     → 浏览器收到响应后 React 触发重新导航/刷新
 *     → 此服务端组件重新渲染，await getMessages() 拿到最新列表
 *     → 最新留言列表显示在页面上
 */

import MessageForm from "./MessageForm";
import { getMessages } from "./actions";

export default async function Chapter08Page() {
  /**
   * getMessages() 是普通 async 函数（非 Server Action），
   * 直接在服务端组件里 await 调用，读取内存数组。
   * 在真实项目中这里会是一个数据库查询，例如：
   *   const messages = await db.select().from(messagesTable).orderBy(...);
   */
  const messages = await getMessages();

  return (
    <div>
      <h1>第 08 章 · Server Actions 与表单提交</h1>
      <p className="muted">
        Server Action 是带 <code>"use server"</code> 标记的服务端函数，
        可直接作为 <code>&lt;form action={"{fn}"}&gt;</code> 的处理器。
        表单提交时函数在服务器执行，无需手写 API 路由 + 客户端 fetch。
      </p>

      {/* ── 核心概念卡片 ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>核心流程</h2>
        <ol style={{ paddingLeft: "20px", lineHeight: "2" }}>
          <li>
            在 <code>actions.ts</code> 文件顶部写 <code>"use server"</code>，
            所有导出函数自动成为 Server Action。
          </li>
          <li>
            客户端组件用 <code>useActionState(action, initialState)</code> 包装，
            得到 <code>[state, formAction, isPending]</code>。
          </li>
          <li>
            将 <code>formAction</code> 传给 <code>&lt;form action={"{formAction}"}&gt;</code>，
            React 在提交时自动把 <code>FormData</code> 注入 action 函数。
          </li>
          <li>
            Action 执行完毕后调用 <code>revalidatePath()</code>，
            使服务端组件缓存失效，页面自动重新渲染出最新数据。
          </li>
        </ol>
      </div>

      {/* ── 留言板演示区 ── */}
      <div className="demo-box">
        <h2 style={{ marginTop: 0 }}>
          <span className="tag">实时演示</span>{" "}
          内存留言板
        </h2>

        {/*
         * 服务端组件渲染留言列表：每次 revalidatePath 触发后，
         * Next.js 重新执行此 async 组件，messages 包含最新数据。
         */}
        <h3 style={{ marginBottom: "8px" }}>
          留言列表
          <span className="muted" style={{ fontSize: "13px", marginLeft: "8px" }}>
            （共 {messages.length} 条）
          </span>
        </h3>

        {messages.length === 0 ? (
          <p className="muted" style={{ fontStyle: "italic" }}>
            还没有留言，来发布第一条吧！
          </p>
        ) : (
          <ul style={{ paddingLeft: "20px", marginBottom: "20px" }}>
            {messages.map((msg, i) => (
              <li key={i} style={{ marginBottom: "6px", lineHeight: "1.6" }}>
                {msg}
              </li>
            ))}
          </ul>
        )}

        <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />

        {/*
         * MessageForm 是客户端组件（"use client"），
         * 包含 useActionState hook，负责表单交互与 pending 状态。
         * 服务端组件可以直接渲染客户端组件——这就是 RSC 的组合模式。
         */}
        <h3 style={{ marginBottom: "12px" }}>发布新留言</h3>
        <MessageForm />

        <p className="muted" style={{ fontSize: "12px", marginTop: "16px", marginBottom: 0 }}>
          ⚠ 演示数据存储在服务器内存中。dev 模式热重载后数据会重置（正常现象）。
          生产项目应使用数据库持久化。
        </p>
      </div>

      {/* ── Server Action 两种定义方式 ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>"use server" 的两种位置</h2>

        <p><strong>① 文件顶部（文件级）</strong></p>
        <pre><code>{`// actions.ts
"use server";          // 本文件所有导出函数都是 Server Action

export async function addMessage(prevState, formData) { ... }
export async function deleteMessage(id) { ... }`}</code></pre>

        <p><strong>② 函数内内联</strong>（适合在服务端组件内就地定义）</p>
        <pre><code>{`// page.tsx（服务端组件）
export default async function Page() {
  async function handleSubmit(formData: FormData) {
    "use server";       // 只有这个函数是 Server Action
    const text = formData.get("text");
    // ...
  }
  return <form action={handleSubmit}>...</form>;
}`}</code></pre>

        <p className="muted" style={{ fontSize: "13px" }}>
          文件级写法更适合多个 action 共享同一文件；
          内联写法则可以直接捕获外层服务端组件的变量（闭包），更灵活。
        </p>
      </div>

      {/* ── 安全提示 ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>安全注意事项</h2>
        <ul style={{ paddingLeft: "20px" }}>
          <li>
            Server Action 本质上是一个 <strong>HTTP POST 端点</strong>，
            任何人都可以直接 POST 调用它，不要假设只有「你的页面」会调用它。
          </li>
          <li>
            始终在 action 内部做<strong>输入校验</strong>（长度、类型、格式）。
          </li>
          <li>
            需要登录才能操作的功能，必须在 action 内部<strong>验证用户身份</strong>
            （如读取 session/cookie），不能仅靠前端隐藏按钮。
          </li>
          <li>
            避免直接将用户输入拼接到 SQL 查询中——使用参数化查询或 ORM。
          </li>
        </ul>
      </div>

      {/* ── 本章小结 ── */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>本章小结</h2>
        <ul style={{ paddingLeft: "20px", lineHeight: "2" }}>
          <li>
            <code>"use server"</code> 标记的函数是 Server Action，
            只在服务器执行，不进入客户端 bundle。
          </li>
          <li>
            <code>&lt;form action={"{serverAction}"}&gt;</code> 是 React 19 对
            原生表单的增强，支持渐进增强（JS 未加载也能提交）。
          </li>
          <li>
            <code>useActionState(action, init)</code> 返回
            <code>[state, formAction, isPending]</code>，
            优雅处理返回状态与提交中状态。
          </li>
          <li>
            <code>revalidatePath(path)</code> 使指定路径的服务端组件缓存失效，
            触发重新渲染以展示最新数据。
          </li>
          <li>
            Server Action 是公开的 HTTP 端点，生产中必须做输入校验与权限验证。
          </li>
        </ul>
      </div>
    </div>
  );
}
