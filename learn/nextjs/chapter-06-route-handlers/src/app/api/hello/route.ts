/**
 * 第 06 章 · 路由处理程序示例接口：/api/hello
 *
 * App Router 规定：只要文件名是 route.ts（或 route.js），
 * 该文件就成为一个 HTTP 接口，不会渲染任何 UI。
 * 与 page.tsx 的区别：两者不能出现在 **同一目录**；
 * 这里把接口放到子目录 api/hello/ 下就是为了避开冲突。
 *
 * 你只需要以"HTTP 方法名"为函数名并导出，Next.js 就会自动路由：
 *   GET    → export async function GET(request: Request)
 *   POST   → export async function POST(request: Request)
 *   PUT / PATCH / DELETE / HEAD / OPTIONS 同理，名称必须全大写。
 */

// ─── GET /api/hello?name=张三 ───────────────────────────────────────────────
/**
 * 读取查询参数（search params）示例。
 *
 * 步骤：
 *   1. 用 `new URL(request.url)` 将原始 URL 字符串解析成 URL 对象。
 *   2. 通过 `.searchParams.get('name')` 取得指定参数；若不存在则返回 null。
 *   3. 用 `??` 空值合并运算符提供默认值 "世界"。
 *   4. 用 `Response.json(data)` 构造 JSON 响应（Next.js 15 原生支持，无需 NextResponse）。
 *      等同于：new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
 */
export async function GET(request: Request) {
  // 1. 解析完整 URL 以获取查询字符串
  const { searchParams } = new URL(request.url);

  // 2. 读取 "name" 参数，若不存在则默认 "世界"
  const name = searchParams.get("name") ?? "世界";

  // 3. 构造响应数据对象
  const data = {
    message: `你好，${name}！`,
    // 返回当前服务端时间（ISO 格式），说明每次调用都是实时计算的
    time: new Date().toISOString(),
    // 回显收到的 name，便于前端调试
    receivedName: name,
  };

  // 4. Response.json() 是浏览器原生 API，Next.js 15 在服务端也支持
  //    它会自动设置 Content-Type: application/json 响应头
  return Response.json(data);
}

// ─── POST /api/hello ─────────────────────────────────────────────────────────
/**
 * 读取请求体（request body）示例。
 *
 * 步骤：
 *   1. 调用 `await request.json()` 解析客户端发送的 JSON 请求体。
 *      注意：这是一个异步操作，必须 await；若请求体不是合法 JSON 会抛出错误。
 *   2. 用 try/catch 包裹，解析失败时返回 400 Bad Request。
 *   3. 回显收到的数据，方便前端验证接口是否正常工作。
 *
 * 客户端调用示例：
 *   fetch('/api/hello', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ foo: 'bar' }),
 *   })
 */
export async function POST(request: Request) {
  try {
    // 1. 异步读取并解析 JSON 请求体
    //    request.json() 内部等同于 JSON.parse(await request.text())
    const body: unknown = await request.json();

    // 2. 构造回显响应：把收到的内容原样返回，方便调试
    const data = {
      youSent: body,
      receivedAt: new Date().toISOString(),
      hint: "以上是服务端收到的请求体原始内容",
    };

    return Response.json(data);
  } catch {
    // 3. 请求体解析失败（例如客户端发了非 JSON 内容）
    return Response.json(
      { error: "请求体必须是合法的 JSON 格式" },
      { status: 400 } // 第二个参数可以传 ResponseInit，设置状态码、响应头等
    );
  }
}
