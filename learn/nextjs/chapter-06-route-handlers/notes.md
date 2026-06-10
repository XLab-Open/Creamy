# 第 06 章笔记：路由处理程序（Route Handlers / API Routes）

## 1. 什么是路由处理程序

在 Next.js App Router 中，**路由处理程序**（Route Handler）是用来创建 HTTP API 接口的机制。它让你在同一个 Next.js 项目里同时拥有前端页面和后端接口，无需额外搭建独立的 API 服务器。

创建方式极其简单：在 `src/app/` 的任意目录下新建一个名为 **`route.ts`**（或 `route.js`）的文件，导出与 HTTP 方法同名的函数即可。

```
src/app/
└── api/
    └── users/
        └── route.ts   ← 对应 /api/users 这个接口
```

---

## 2. route.ts 与 page.tsx 的本质区别

| 特性 | `page.tsx` | `route.ts` |
|------|-----------|-----------|
| 作用 | 渲染 HTML 页面 | 处理 HTTP 请求，返回数据 |
| 返回值 | JSX（React 元素） | `Response` 对象 |
| 访问方式 | 浏览器直接打开 | `fetch()`、curl、Postman |
| 能否共存于同一目录 | **不能**（会冲突） | **不能**（同上） |
| 典型用途 | 用户界面 | REST API、Webhook 回调 |

> **常见坑**：`route.ts` 和 `page.tsx` **不能放在同一目录**。若你想给某个页面路由配套一个接口，必须把接口放到子目录（如 `api/` 子目录）下。

---

## 3. 支持的 HTTP 方法

Next.js 路由处理程序支持以下方法，**函数名必须全大写**：

```ts
export async function GET(request: Request) { ... }
export async function POST(request: Request) { ... }
export async function PUT(request: Request) { ... }
export async function PATCH(request: Request) { ... }
export async function DELETE(request: Request) { ... }
export async function HEAD(request: Request) { ... }
export async function OPTIONS(request: Request) { ... }
```

同一个 `route.ts` 文件可以导出多个方法。若请求的方法没有对应的导出函数，Next.js 会自动返回 **405 Method Not Allowed**。

---

## 4. 读取请求信息的三种方式

### 4.1 读取查询参数（Query / Search Params）

```ts
export async function GET(request: Request) {
  // 将 URL 字符串解析成 URL 对象，再访问 searchParams
  const { searchParams } = new URL(request.url);

  // .get() 返回 string | null；用 ?? 提供默认值
  const page = searchParams.get('page') ?? '1';
  const keyword = searchParams.get('q') ?? '';

  return Response.json({ page: Number(page), keyword });
}
```

`URL` 是 Web 标准 API，在 Node.js 和 Edge 运行时都可用，无需 import。

### 4.2 读取请求体（Request Body）

```ts
export async function POST(request: Request) {
  // request.json() 是异步的，必须 await
  // 内部等同于 JSON.parse(await request.text())
  const body = await request.json();

  // 其他格式：
  // const text = await request.text();      // 纯文本
  // const form = await request.formData();  // 表单数据
  // const buf  = await request.arrayBuffer(); // 二进制

  return Response.json({ received: body });
}
```

> **注意**：`request.json()` 若请求体不是合法 JSON 会抛出异常，建议用 `try/catch` 包裹。

### 4.3 读取请求头（Request Headers）

```ts
export async function GET(request: Request) {
  // 方式一：直接访问原生 Headers 对象
  const auth = request.headers.get('Authorization');

  // 方式二：用 NextRequest（需从 next/server 导入）
  // import { NextRequest } from 'next/server';
  // export async function GET(request: NextRequest) {
  //   const token = request.cookies.get('token')?.value;
  // }

  return Response.json({ hasAuth: !!auth });
}
```

---

## 5. 返回响应的两种方式

### 5.1 `Response.json()`（推荐，Web 标准）

```ts
// 基本用法
return Response.json({ message: '成功' });

// 带自定义状态码和响应头
return Response.json(
  { error: '未授权' },
  {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Bearer',
    },
  }
);
```

`Response.json()` 是浏览器原生 `Response` API 的静态方法，Next.js 15 在服务端同样支持，**无需任何 import**。它会自动设置 `Content-Type: application/json` 响应头。

### 5.2 `NextResponse.json()`（Next.js 专属，功能更多）

```ts
import { NextResponse } from 'next/server';

return NextResponse.json(
  { data: result },
  {
    status: 200,
    headers: { 'X-Custom-Header': 'hello' },
  }
);
```

`NextResponse` 继承自 `Response`，额外提供了 `.cookies`（方便操作 Cookie）和 `.redirect()` 等便捷方法。两者在返回 JSON 时功能等价，`Response.json()` 更简洁，`NextResponse` 在需要操作 Cookie 或重定向时更方便。

---

## 6. 动态渲染 vs 静态缓存

### Next.js 15 的默认行为

- **Next.js 15**：GET 路由处理程序**默认不缓存**，每次请求都执行。
- **Next.js 14**：GET 路由处理程序在某些条件下可能被静态化。

### 手动控制缓存行为

```ts
// 强制动态（每次请求都重新执行，不缓存）
export const dynamic = 'force-dynamic';

// 强制静态（构建时执行一次，结果被缓存）
export const dynamic = 'force-static';

// 按时间重新验证（类似 ISR）
export const revalidate = 60; // 60 秒后缓存失效，下次请求重新执行

// 指定运行时（默认 Node.js，可改为 Edge）
export const runtime = 'edge';
```

### 典型场景

| 接口类型 | 推荐配置 |
|---------|---------|
| 返回实时数据（时间、股价） | `dynamic = 'force-dynamic'` |
| 返回静态配置（不变的配置项） | `dynamic = 'force-static'` |
| 数据定期更新（博客文章列表） | `revalidate = 3600` |

---

## 7. 动态路由参数

路由处理程序也支持动态段，通过第二个参数 `context` 获取：

```ts
// src/app/api/users/[id]/route.ts
// 对应 /api/users/123

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Next.js 15 中 params 是一个 Promise，需要 await
  const { id } = await params;
  return Response.json({ userId: id });
}
```

> **Next.js 15 的变化**：`params` 现在是 `Promise`，与 Next.js 14 不同，必须 `await`。

---

## 8. CORS 与边缘运行时（一句话提及）

- **CORS**：在响应头中添加 `'Access-Control-Allow-Origin': '*'` 即可允许跨域；`OPTIONS` 方法用于处理 CORS 预检请求。
- **边缘运行时**：加 `export const runtime = 'edge'` 可将接口部署到 Vercel Edge Network，启动更快，但可用 Node.js API 受限（无 `fs`、`crypto` 等）。

---

## 9. 常见坑总结

### 坑 1：route.ts 与 page.tsx 同目录共存

```
❌ 错误示例
src/app/users/
  ├── page.tsx    ← 页面
  └── route.ts   ← 接口 (与 page.tsx 在同一目录，会报错)

✅ 正确做法
src/app/users/
  ├── page.tsx            ← 用户列表页面
  └── api/
      └── route.ts        ← /users/api 接口
```

### 坑 2：方法名必须大写

```ts
// ❌ 错误：小写方法名不会被识别，请求会返回 405
export async function get(request: Request) { ... }

// ✅ 正确：必须全大写
export async function GET(request: Request) { ... }
```

### 坑 3：忘记 await request.json()

```ts
// ❌ 错误：body 是 Promise，不是实际数据
const body = request.json();
return Response.json({ received: body }); // 返回 "{}"

// ✅ 正确：必须 await
const body = await request.json();
```

### 坑 4：Next.js 15 中 params 是 Promise

```ts
// ❌ Next.js 14 的写法，在 15 中会报类型错误
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params; // 在 Next.js 15 中 params 是 Promise
}

// ✅ Next.js 15 正确写法
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
}
```

---

## 10. 小练习

完成下面的练习，巩固本章知识点：

1. **练习一（GET）**：在 `src/app/api/echo/route.ts` 创建一个接口，读取查询参数 `text`，返回 `{ echo: text, length: text.length }`。

2. **练习二（POST）**：在同目录创建 `route.ts` 导出 `POST` 函数，接收 `{ a: number, b: number }`，返回 `{ sum: a + b }`。

3. **练习三（状态码）**：修改练习二，当 `a` 或 `b` 不是数字时，返回 HTTP 400 状态码和错误信息。

4. **练习四（动态路由）**：创建 `src/app/api/items/[id]/route.ts`，实现 `GET` 返回 `{ id, name: "物品" + id }`，实现 `DELETE` 返回 `{ deleted: true, id }`。

5. **进阶思考**：路由处理程序能否在服务端直接访问数据库？答案是可以的——因为它运行在服务端，可以安全地使用数据库客户端（如 Prisma、pg）。试着在接口里 `console.log('我在服务端运行')` 并观察日志出现在哪里（终端，不是浏览器控制台）。
