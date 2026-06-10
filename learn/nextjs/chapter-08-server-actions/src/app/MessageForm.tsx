/**
 * MessageForm.tsx — 客户端留言提交表单
 *
 * 第一行的 "use client" 将本模块标记为「客户端组件」边界：
 * - 本文件及其子组件会被打包进客户端 bundle。
 * - 可以使用浏览器 API、React hooks（useState、useEffect、useActionState 等）。
 * - 不可直接访问服务端资源（数据库、文件系统），但可以调用 Server Action。
 */
"use client";

import { useActionState } from "react";
import { addMessage } from "./actions";

/**
 * useActionState 是 React 19 新增的 hook，专为与 Server Action 配合而设计。
 *
 * 用法：
 *   const [state, formAction, isPending] = useActionState(action, initialState);
 *
 * 三个返回值：
 *   state      — action 最近一次返回的状态；首次渲染时为 initialState。
 *                每次表单提交并执行完 action 后自动更新。
 *   formAction — 包装后的 action，应当作为 <form action={formAction}> 的值；
 *                React 会在提交时自动把 prevState 和 FormData 注入给原始 action。
 *   isPending  — boolean，表单正在提交（action 尚未返回）时为 true；
 *                可用来禁用按钮、显示加载提示，防止重复提交。
 *
 * 与旧版 useFormState（React 18 实验性 API）的区别：
 *   useActionState 新增了第三个返回值 isPending，使用更方便，
 *   且在 React 19 中已成为正式稳定 API。
 */
export default function MessageForm() {
  const [state, formAction, isPending] = useActionState(addMessage, {
    ok: true,
    error: null,
  });

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/*
       * <form action={formAction}> 是 React 19 对 HTML 表单的增强：
       * - 传统 HTML：action 是 URL 字符串（提交到某个路由）。
       * - React 19：action 可以是函数（Server Action 或普通函数），
       *   提交时 React 拦截浏览器默认行为，将 FormData 传给该函数。
       * - 渐进增强：即便 JavaScript 尚未加载完成（SSR 场景），
       *   表单仍可提交——Next.js 会将 Server Action 映射到一个隐藏的 POST 端点。
       */}

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <input
          name="text"
          type="text"
          placeholder="写下你的留言（最多 200 字）"
          disabled={isPending}
          style={{
            flex: 1,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: "7px",
            padding: "8px 12px",
            color: "var(--text)",
            fontSize: "14px",
            outline: "none",
          }}
        />
        {/*
         * isPending 为 true 时禁用按钮并更换文字，
         * 避免用户在 action 执行期间重复点击提交。
         * Server Action 是异步的（网络往返），禁用状态体验更好。
         */}
        <button
          type="submit"
          className="btn"
          disabled={isPending}
          style={{ opacity: isPending ? 0.6 : 1, cursor: isPending ? "not-allowed" : "pointer" }}
        >
          {isPending ? "提交中…" : "发布留言"}
        </button>
      </div>

      {/* 错误提示：state.error 非空时以红色显示 */}
      {state.error && (
        <p style={{ color: "#f87171", fontSize: "13px", margin: 0 }}>
          ⚠ {state.error}
        </p>
      )}

      {/* 成功提示：ok 为 true 且非初始状态时给出反馈（靠 error 为 null 且 ok 为 true 区分） */}
      {state.ok && !state.error && (
        <p style={{ color: "#4ade80", fontSize: "13px", margin: 0 }}>
          ✓ 留言已发布！
        </p>
      )}
    </form>
  );
}
