# 第 04 章 · 服务端组件 vs 客户端组件

> 对应路由：`/`（独立项目，根路由即本章内容）
> 核心文件：`src/app/page.tsx`（服务端组件）· `src/app/Counter.tsx`（客户端组件）

---

## 1. 什么是 React 服务端组件（RSC）

**React Server Components（RSC）** 是 React 18 引入、Next.js App Router 深度集成的一种组件渲染模式。与传统的"所有组件都在浏览器运行"不同，RSC 让组件可以在服务器（Node.js 环境）上执行，并把渲染结果以特殊的序列化格式（React 服务端负载，不是纯 HTML）传给浏览器。

**App Router 的默认行为：所有组件默认是服务端组件。** 只要文件顶部没有 `"use client"` 声明，Next.js 就把它当作服务端组件处理。

### RSC 的三大核心特性

| 特性 | 说明 |
|------|------|
| **代码不入 bundle** | 服务端组件的 JS 不发送给浏览器，减少传输体积 |
| **直接访问后端** | 可以 `await` 数据库查询、读取文件、访问 `process.env` 密钥，无需 API 层 |
| **默认行为** | 无需任何声明，App Router 中的组件天生是服务端组件 |

---

## 2. 默认服务端的好处

### 2.1 更少的 JavaScript 发送给浏览器

传统 SPA 中，所有组件的 JS 都要打包发到客户端，即使它们只是静态展示内容。RSC 让纯展示性组件（导航、文章正文、静态列表）留在服务器，浏览器只收到渲染结果，**不含组件本身的代码逻辑**。这直接降低了 bundle 体积，加快首屏加载。

### 2.2 可直接访问数据源

服务端组件可以像写 Node.js 脚本一样操作数据：

```typescript
// 这是服务端组件，可以直接 await 数据库
export default async function ProductList() {
  const products = await db.query("SELECT * FROM products LIMIT 20");
  return <ul>{products.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

不需要先写一个 API Route、再在客户端 `fetch` 它，减少了一个网络往返。

### 2.3 保护密钥与敏感逻辑

```typescript
// 服务端组件中使用密钥，绝对安全
const data = await fetch("https://api.example.com/data", {
  headers: { Authorization: `Bearer ${process.env.SECRET_API_KEY}` },
});
```

`process.env.SECRET_API_KEY` 只在 Node.js 环境里存在，服务端组件的代码不会出现在浏览器 DevTools 的 Sources 里。客户端组件如果不小心引用了 `process.env.NEXT_PUBLIC_*` 以外的环境变量，值会是 `undefined`（Next.js 有此保护）。

---

## 3. `"use client"` 的含义与「边界」概念

### 3.1 基本用法

在文件**第一行**（比任何 import 更早）写：

```typescript
"use client";

import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

这个文件就成为客户端组件，可以使用所有 React Hooks 和浏览器 API。

### 3.2 边界（Boundary）的精确含义

`"use client"` 声明的不是「某一个组件是客户端组件」，而是「**从这个文件开始，向下的整个子树进入客户端**」。

```
app/layout.tsx         ← 服务端（没有 "use client"）
└── page.tsx           ← 服务端（没有 "use client"）
    ├── Header.tsx     ← 服务端（没有 "use client"）
    └── Counter.tsx    ← ★ "use client" 边界
        └── Button.tsx ← 自动进入客户端（被 Counter 导入）
```

在上面的树中，即使 `Button.tsx` 没有写 `"use client"`，因为它被 `Counter.tsx` 导入，也会自动进入客户端 bundle。

### 3.3 边界应尽量下沉

**核心原则：把 `"use client"` 边界尽量下沉到叶子组件。**

❌ 反面例子：在根 Layout 加 `"use client"`
```typescript
// src/app/layout.tsx ← 千万不要这么做
"use client";  // 整棵应用组件树都进入 bundle！
```

✅ 正确做法：只在真正需要交互的最小组件加

```typescript
// src/app/layout.tsx ← 保持服务端组件
export default function RootLayout({ children }) { ... }

// src/app/components/LikeButton.tsx ← 只有这个需要 "use client"
"use client";
export default function LikeButton() {
  const [liked, setLiked] = useState(false);
  return <button onClick={() => setLiked(true)}>{liked ? "❤️" : "🤍"}</button>;
}
```

---

## 4. 服务端组件与客户端组件能力对照表

| 能力 | 服务端组件 (RSC) | 客户端组件 ("use client") |
|------|:---:|:---:|
| `async/await` 直接获取数据 | ✅ | ❌（需要 useEffect + fetch） |
| 访问 `process.env` 密钥 | ✅ | ❌（会暴露或报错） |
| Node.js 原生模块（fs、crypto） | ✅ | ❌ |
| 代码进入浏览器 bundle | ❌（不发给浏览器） | ✅ |
| `useState` / `useReducer` | ❌ | ✅ |
| `useEffect` / `useLayoutEffect` | ❌ | ✅ |
| `useRef` / `useContext` | ❌ | ✅ |
| `onClick` 等事件处理器 | ❌ | ✅ |
| 浏览器 API（`window`、`document`） | ❌ | ✅ |
| 可以渲染其他服务端组件 | ✅ | ⚠️（通过 `children` prop） |
| 可以渲染客户端组件 | ✅ | ✅ |
| 首屏 HTML 输出（SEO 友好） | ✅ | ✅（SSR + hydration） |

---

## 5. 服务端向客户端传递数据：Props 必须可序列化

服务端组件在服务器上运行，客户端组件在浏览器里 hydrate。两者之间的数据传递需要「跨越网络边界」——数据必须被**序列化**（类似 JSON 的过程）后才能从服务端传到客户端。

### 5.1 可以传的值

- 基本类型：`string`、`number`、`boolean`、`null`、`undefined`
- 纯数据对象：`{ name: "Alice", age: 30 }`
- 数组：`[1, 2, 3]`、`["a", "b"]`
- 嵌套以上类型的结构

### 5.2 不能直接传的值（会报运行时错误）

| 类型 | 解决方案 |
|------|----------|
| `Function`（普通函数） | 改用 Server Actions（`"use server"` 标记） |
| `Date` 对象 | 转为 ISO 字符串 `.toISOString()`，客户端 `new Date(str)` |
| `Map` / `Set` | 转为数组或对象 |
| 类实例（class instance） | 转为普通对象（plain object） |
| `Symbol` | 通常不需要跨边界传，重新定义 |
| `RegExp` | 转为字符串 |

### 5.3 代码示例

```typescript
// page.tsx（服务端组件）
import Counter from "./Counter";

export default function Page() {
  const user = { name: "Alice", score: 42 }; // ✅ 普通对象，可序列化

  return (
    <>
      {/* ✅ 可序列化的 props */}
      <Counter label={user.name} initial={user.score} />

      {/* ❌ 不能这样做：函数作为 prop（非 Server Action）*/}
      {/* <Counter onReset={() => console.log("reset")} /> */}
    </>
  );
}
```

---

## 6. 常见坑与解决方法

### 坑 1：在服务端组件里用 `useState`

```typescript
// ❌ 错误：page.tsx 没有 "use client"，但用了 useState
export default function Page() {
  const [count, setCount] = useState(0); // 报错！
  return <div>{count}</div>;
}
```

**报错信息：** `You're importing a component that needs useState. It only works in a Client Component, but none of its parents are marked with "use client"`

**解决：** 把需要 state 的部分拆出到独立文件，加 `"use client"`。

---

### 坑 2：把 `"use client"` 放太高导致 bundle 变大

```typescript
// ❌ 错误：在根布局加 "use client"，整棵树都变成客户端组件
// src/app/layout.tsx
"use client";
```

即使你只是需要在某个小按钮里用 `useState`，这样做会让应用里**所有页面、所有组件**都进入 bundle，彻底失去 RSC 的价值。

**解决：** 只在真正需要的叶子组件文件加 `"use client"`，保持上层组件为服务端组件。

---

### 坑 3：Hydration Mismatch（水合不匹配）

服务端渲染的 HTML 和客户端 hydration 时的 React 渲染结果不一致时，React 会警告（开发模式）或静默出错（生产模式）。

**常见触发场景：**

```typescript
"use client";
// ❌ Math.random() 在服务端和客户端的结果不同
const [value] = useState(Math.random());

// ❌ 时间在服务端和客户端不同步
const [now] = useState(Date.now());
```

**解决方案：**

```typescript
"use client";
import { useState, useEffect } from "react";

// ✅ 方案 1：从服务端通过 props 传入固定值
export function Counter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial); // 固定值，不会不匹配
}

// ✅ 方案 2：用 useEffect 在客户端初始化（只在浏览器执行）
export function RandomDisplay() {
  const [value, setValue] = useState(0);
  useEffect(() => {
    setValue(Math.random()); // 只在浏览器执行，hydration 时 value 还是 0
  }, []);
  return <div>{value}</div>;
}
```

---

### 坑 4：误以为客户端组件"不做 SSR"

很多初学者以为 `"use client"` = 纯客户端渲染（像 CRA 那样）。实际上：

- 客户端组件**依然**在服务端做一次 SSR，生成初始 HTML（利于 SEO、加快首屏）
- 浏览器收到 HTML 后，再下载对应的 JS bundle 进行 **hydration**（事件绑定、state 恢复）
- `"use client"` 真正的含义：**需要客户端 JavaScript 运行时来提供交互能力**

---

### 坑 5：在客户端组件中 import 了服务端专属模块

如果一个客户端组件（有 `"use client"`）import 了只能在 Node.js 运行的模块（如 `fs`、`crypto`、数据库驱动），构建时会报错，因为这些模块无法在浏览器里运行。

**解决：** 在 `package.json` 中为模块设置 `"browser": false`，或将数据库访问逻辑移回服务端组件（或 Server Action）。

---

## 7. 二者如何协作：完整数据流

```
服务端（Node.js）                      浏览器
─────────────────────────────────────  ─────────────────────────
1. page.tsx 执行                       
   ├── 计算 serverRenderedAt           
   ├── 设定 COUNTER_INITIAL = 5        
   └── 渲染 JSX（含 Counter 组件）     
        ↓                              
2. Next.js 序列化 RSC Payload          
   ├── HTML shell（Counter 的初始 HTML）→  浏览器渲染首屏 HTML
   └── 客户端 bundle（Counter.tsx JS） →  浏览器下载 JS
                                           ↓
                                       3. Hydration
                                          ├── React 对比 HTML 与虚拟 DOM
                                          ├── 绑定 onClick 事件
                                          └── useState(5) 初始化
                                               ↓
                                       4. 用户点击按钮
                                          setCount(c => c + 1)
                                          → React 重新渲染（仅在浏览器）
                                          → 无网络请求
```

---

## 8. 小练习

1. **验证服务端组件代码不入 bundle：**
   在 `page.tsx` 里写一行注释 `// SUPER_SECRET_MARKER`，启动开发服务器后，打开 DevTools → Network，搜索页面的 JS 文件，看看能否找到这个字符串。（你会发现找不到——它只在服务端执行。）

2. **故意触发服务端组件报错：**
   在 `page.tsx`（没有 `"use client"`）里添加 `import { useState } from "react"`，然后在函数体里写 `useState(0)`，观察 Next.js 抛出的错误信息。

3. **下沉边界练习：**
   新建一个页面，包含一个复杂的「文章列表」（服务端组件，直接 `await` 获取数据）和一个「收藏按钮」（客户端组件，需要 `useState` 跟踪收藏状态）。观察只有按钮部分有 `"use client"` 时的 bundle 大小，与把 `"use client"` 放在文章列表根组件时的差异。

4. **Hydration Mismatch 复现：**
   在 `Counter.tsx` 里把 `useState(initial)` 改为 `useState(Math.random())`，观察浏览器控制台的警告信息，然后用 `useEffect` 的方案修复它。

---

## 小结

| 记忆点 | 内容 |
|--------|------|
| 默认服务端 | App Router 中所有组件默认是服务端组件，无需声明 |
| 边界声明 | 文件第一行写 `"use client"` 开启客户端组件树 |
| 边界下沉 | 把 `"use client"` 放到最小的叶子组件，减少 bundle |
| Props 序列化 | 跨边界传的 props 只能是可序列化的值 |
| 客户端组件也做 SSR | `"use client"` ≠ 跳过服务端渲染，只是需要客户端 JS |
| 避免不匹配 | 随机值/时间等不稳定数据用固定值初始化或移入 `useEffect` |
