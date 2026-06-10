# 第 08 章笔记：Server Actions 与表单提交

## 一、Server Actions 是什么

Server Actions 是 Next.js 13.4（App Router）引入、React 19 正式稳定的特性。
简单说：**带 `"use server"` 标记的 async 函数，能被客户端直接"调用"，但实际上在服务器上运行**。

传统的表单提交流程：

```
前端表单 → fetch/axios POST /api/xxx → API Route 处理 → 操作数据库 → 返回 JSON → 前端更新 UI
```

使用 Server Actions 后：

```
前端表单 → <form action={serverAction}> → Server Action 在服务器执行 → revalidatePath → UI 自动更新
```

省去了中间「手写 API 路由 + 手写 fetch」两个环节，代码更紧凑，类型安全也更好（无需手动序列化/反序列化 JSON）。

---

## 二、`"use server"` 的两种用法

### 1. 文件级（推荐，多 action 场景）

```typescript
// app/actions.ts
"use server";   // 第一行，整个文件所有导出函数都是 Server Action

export async function createPost(prevState, formData: FormData) { ... }
export async function deletePost(id: string) { ... }
```

- 适合把多个相关 action 集中管理。
- 文件不能同时包含客户端代码（不能混用 useState 等）。

### 2. 函数内内联（灵活，可捕获外层变量）

```typescript
// app/page.tsx（服务端组件）
export default async function Page() {
  const userId = await getCurrentUserId();  // 服务端变量

  async function handleDelete(formData: FormData) {
    "use server";   // 只有这个函数是 Server Action
    await deletePost(formData.get("id") as string, userId);  // 可以闭包捕获 userId
    revalidatePath("/posts");
  }

  return <form action={handleDelete}>...</form>;
}
```

- 优点：可以直接访问外层服务端组件的变量，无需通过隐藏字段传递。
- 适合临时、单一用途的 action。

---

## 三、`<form action={serverAction}>` 渐进增强

React 19 扩展了 HTML `<form>` 的 `action` 属性，使其接受函数（而非只接受 URL 字符串）：

```tsx
<form action={myServerAction}>
  <input name="title" />
  <button type="submit">提交</button>
</form>
```

**渐进增强（Progressive Enhancement）** 是指：即便客户端 JavaScript 尚未加载（如慢网络 SSR 首屏），表单仍可提交。Next.js 在构建时为每个 Server Action 生成一个唯一的隐藏 POST 端点，原生 HTML 表单提交会打到这个端点，Action 在服务器执行，然后返回重定向响应——全程无需 JS。

当 JS 加载完毕后，React 会接管，拦截提交事件，用 fetch 异步发送，提供更流畅的体验（不刷新页面、显示 pending 状态等）。

---

## 四、`useActionState` — 管理 Action 的状态与 Pending

`useActionState` 是 React 19 正式稳定的 hook，专门用于配合 Server Action 的表单交互。

```typescript
import { useActionState } from "react";

const [state, formAction, isPending] = useActionState(action, initialState);
```

| 返回值 | 类型 | 说明 |
|--------|------|------|
| `state` | `ActionState` | action 最近一次返回的值；首次为 `initialState` |
| `formAction` | `function` | 包装后的 action，传给 `<form action>` |
| `isPending` | `boolean` | 提交进行中为 `true`，可用于禁用按钮 |

**Action 签名约定**（useActionState 版本）：

```typescript
async function myAction(
  prevState: MyState,   // 上一次返回的状态
  formData: FormData    // 浏览器表单数据
): Promise<MyState> {
  "use server";
  // ...
  return { ok: true, error: null };
}
```

---

## 五、`useFormStatus` 一句话提及

如果你的提交按钮独立成一个子组件，`useActionState` 的 `isPending` 无法直接传进去时，可以用 React 19 的 `useFormStatus` hook：

```typescript
import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();  // 自动感知最近祖先 <form> 的提交状态
  return <button disabled={pending}>{pending ? "提交中…" : "提交"}</button>;
}
```

`useFormStatus` 必须用在 `<form>` 的**子组件**内，不能和表单在同一个组件里。

---

## 六、`revalidatePath` 与 `revalidateTag` — 刷新缓存

Next.js 默认会缓存服务端组件的渲染结果。数据变更后需要手动告知框架「缓存已过期」。

### `revalidatePath(path, type?)`

```typescript
import { revalidatePath } from "next/cache";

revalidatePath("/posts");          // 使 /posts 路径的缓存失效
revalidatePath("/posts/[id]", "page");   // 只使 page 缓存失效（不含 layout）
revalidatePath("/", "layout");           // 使根 layout 缓存失效（影响所有页面）
```

### `revalidateTag(tag)`

更细粒度的控制——在 fetch 时打标签，按标签批量失效：

```typescript
// 数据获取时打标签
const data = await fetch("/api/posts", { next: { tags: ["posts"] } });

// Action 中按标签失效
import { revalidateTag } from "next/cache";
revalidateTag("posts");   // 所有打了 "posts" 标签的 fetch 缓存都失效
```

### 何时用哪个？

- 路径固定、影响单一页面 → `revalidatePath`
- 同一数据被多个页面使用 → `revalidateTag`（更精确，性能更好）

---

## 七、安全注意事项

**Server Action 是公开的 HTTP POST 端点**，构建时 Next.js 会为每个 action 生成唯一 ID，客户端通过该 ID 发起 POST 请求。这意味着：

1. **任何人都可以直接 curl 调用你的 action**，不仅限于你的 UI。
2. 必须在 **action 内部**做完整的输入校验（不能只靠前端 maxlength、disabled 等）。
3. 需要身份验证的操作，必须在 action 里读取 session/cookie 验证用户，不能假设「只有登录用户才能看到提交按钮」。
4. 避免 SQL 注入：使用参数化查询或 ORM，不要拼接原始 SQL。
5. 避免 CSRF：Next.js Server Actions 内置了 Origin 检查（same-origin），但跨域场景需额外注意。

```typescript
"use server";
import { auth } from "@/lib/auth";

export async function deletePost(prevState, formData: FormData) {
  // 1. 验证用户身份
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  // 2. 校验输入
  const id = formData.get("id") as string;
  if (!id || !/^\d+$/.test(id)) return { error: "无效的 ID" };

  // 3. 权限检查（确保用户只能删除自己的内容）
  const post = await db.post.findUnique({ where: { id: Number(id) } });
  if (post?.authorId !== session.user.id) return { error: "无权操作" };

  // 4. 执行操作
  await db.post.delete({ where: { id: Number(id) } });
  revalidatePath("/posts");
  return { ok: true };
}
```

---

## 八、dev 内存重置说明

本章演示使用模块级数组 `messages: string[]` 作为临时存储。

在 **dev 模式**（`next dev`）下：
- Next.js 使用 HMR（Hot Module Replacement）热重载，文件保存后模块会被重新执行。
- 模块重新执行意味着 `messages` 数组被重新初始化为 `[]`，之前的留言消失。
- **这是正常的**，不是 bug。

在 **production 模式**（`next build` + `next start`）下：
- 单进程内模块只初始化一次，数组在进程生命周期内持久存在。
- 但多实例部署（Vercel、Docker 水平扩展）时，每个实例有独立内存，数据不共享。

**结论**：内存存储仅适合演示。真实项目应使用持久化存储（PostgreSQL、MySQL、SQLite、Redis 等）。

---

## 九、常见坑

### 坑 1：忘记 `"use server"` 标记
Action 函数没有 `"use server"`，Next.js 会报错或将其当成普通函数在客户端执行，无法访问服务端资源。

### 坑 2：在 Server Action 文件里写了客户端代码
`"use server"` 文件不能 import 客户端专用模块（如 `import { useState } from "react"`），否则构建报错。

### 坑 3：忘记调用 `revalidatePath`
数据已更新但页面没刷新——因为 Next.js 还在用旧的缓存。提交数据后记得调用 `revalidatePath` 或 `revalidateTag`。

### 坑 4：`useActionState` 和 `useFormState` 混淆
`useFormState`（React 18 实验性）已被 `useActionState`（React 19 稳定）取代，两者签名相似但 `useActionState` 多了第三个返回值 `isPending`。新项目统一用 `useActionState`。

### 坑 5：action 签名不符合 `useActionState` 约定
使用 `useActionState` 时，action **第一个参数必须是 prevState**，第二个才是 FormData。如果直接写 `async function action(formData: FormData)` 但放进 `useActionState`，prevState 会被当成 formData 传入，逻辑错误。

### 坑 6：`revalidatePath` 在 action 之外调用
`revalidatePath` 只能在 Server Action 或 Route Handler 中调用（服务端代码）。在客户端组件里直接调用会报错。

---

## 十、小练习

1. **基础练习**：在 `addMessage` 中增加过滤词校验（如含有"垃圾"则拒绝），并在页面显示相应错误信息。
2. **进阶练习**：添加一个「删除留言」功能——在每条留言后面加删除按钮，创建 `deleteMessage(index: number)` Server Action，通过隐藏的 `<input name="index" value={i}>` 传递下标。
3. **挑战练习**：将内存数组替换为文件系统存储（`fs.readFileSync` / `fs.writeFileSync` 读写 JSON 文件），使数据在热重载后依然保留（注意：仅适用于单机部署）。
4. **思考题**：如果同一个留言板部署到两台服务器，A 用户的留言提交到服务器 1，B 用户访问到服务器 2，会发生什么？如何解决？

---

## 总结

| 概念 | 要点 |
|------|------|
| `"use server"` | 标记服务端函数，两种位置：文件顶部 / 函数内内联 |
| `<form action={fn}>` | React 19 表单增强，渐进增强，JS 可用时更流畅 |
| `useActionState` | 管理 action 返回状态与 pending，三返回值 |
| `useFormStatus` | 子组件感知最近祖先表单的 pending 状态 |
| `revalidatePath` | 按路径使缓存失效，触发服务端组件重渲 |
| `revalidateTag` | 按标签批量失效，适合跨页面共享数据 |
| 安全 | Action 是公开 POST 端点，必须做校验与鉴权 |
