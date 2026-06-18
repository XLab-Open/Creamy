/**
 * actions.ts — 服务端专用模块
 *
 * 文件第一行的 "use server" 是一个 React / Next.js 指令（directive），
 * 作用：告诉打包器「本文件的所有导出函数都是 Server Action」，
 * 即这些函数只会在服务器上执行，绝不会被打包进客户端 bundle。
 *
 * 另一种写法是「函数内内联」：
 *   async function myAction(formData: FormData) {
 *     "use server";   // 只有这一个函数是 Server Action
 *     ...
 *   }
 * 文件级写法更简洁；内联写法更灵活，可在服务端组件内直接定义。
 */
"use server";

import { revalidatePath } from "next/cache";

/**
 * 内存留言板存储。
 *
 * 这是一个模块级变量——Node.js 进程启动后它就一直存在于内存里，
 * 直到进程退出（或 dev 模式下热重载）才会重置。
 *
 * ⚠️  仅用于教学演示：
 *   - dev 模式（next dev）热重载时，模块会被重新执行，数组清空——这是正常的。
 *   - production（next build + next start）模式下，在单进程内数据会持久保留，
 *     但多实例部署（如 Vercel Serverless）时每个实例有独立内存，不会共享。
 *   - 真实项目应将数据存入数据库（PostgreSQL、SQLite 等），而非内存变量。
 */
const messages: string[] = [];

/**
 * addMessage — 处理「新增留言」表单提交的 Server Action。
 *
 * 签名遵循 React 19 useActionState 的约定：
 *   (prevState: ActionState, formData: FormData) => Promise<ActionState>
 *
 * @param prevState - 上一次 action 执行后返回的状态（首次为 initialState）
 * @param formData  - 浏览器原生 FormData 对象，包含表单中所有字段的值；
 *                    Next.js 会把表单提交自动序列化为 FormData 传入，
 *                    无需手动解析 request body。
 *
 * FormData 用法：
 *   formData.get("fieldName")  → 取单个值（string | File | null）
 *   formData.getAll("name")    → 取多值（如 checkbox 多选）
 *   formData.has("name")       → 判断字段是否存在
 */
export async function addMessage(
  prevState: { ok: boolean; error: string | null },
  formData: FormData
): Promise<{ ok: boolean; error: string | null }> {
  // 从 FormData 中读取名为 "text" 的字段值
  const text = (formData.get("text") as string | null)?.trim() ?? "";

  // 基本校验：留言不能为空
  if (!text) {
    return { ok: false, error: "留言不能为空" };
  }

  // 长度限制，防止滥用
  if (text.length > 200) {
    return { ok: false, error: "留言不能超过 200 字" };
  }

  // 将留言追加到内存数组
  messages.push(text);

  /**
   * revalidatePath('/') 的作用：
   *
   * Next.js 默认会缓存服务端组件的渲染结果。
   * 当数据发生变化（这里是新增了一条留言）后，需要通知框架：
   * 「根路径 / 对应的页面缓存已过期，下次访问请重新渲染」。
   *
   * 如果不调用 revalidatePath，页面可能在一段时间内还显示旧数据。
   * 调用后，客户端在下次导航或刷新时会得到最新的服务端渲染结果。
   *
   * 类似的 API 还有 revalidateTag(tag)，用于按「缓存标签」批量失效。
   */
  revalidatePath("/");

  return { ok: true, error: null };
}

/**
 * getMessages — 返回当前留言列表的副本（普通 async 函数，非 Server Action）。
 *
 * 返回副本（slice()）而非原数组引用，避免调用方意外修改内部状态。
 * 服务端组件可以直接 await 这个函数来获取数据，无需 fetch 自己的 API。
 */
export async function getMessages(): Promise<string[]> {
  return messages.slice();
}
