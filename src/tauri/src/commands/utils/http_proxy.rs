use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;

use reqwest::Client;
use warp::reply::Reply;
use warp::Filter;

const START_PORT: u16 = 8080;
const MAX_PORT: u16 = 8180;

pub struct ProxyServer {
    pub port: u16
}

impl ProxyServer {
    pub async fn new() -> Self {
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap();
        let ptoxy_client = client.clone();
        let assets_client = client.clone();

        let proxy_filter = warp::path("proxy")
            .and(warp::query::<HashMap<String, String>>())
            .and(warp::header::optional::<String>("range"))
            .and_then({
                let client = ptoxy_client;
                move |params: HashMap<String, String>, range: Option<String>| {
                    let client = client.clone();
                    async move {
                        if let Some(target_url) = params.get("url") {
                            // Range 原样转给上游，返回的 206 也原样回去。前端靠它只取图片
                            // 开头的一小段来读宽高（见 msgUtil.probeImageSize）—— 一张表情
                            // 就有 745KB、慢网上要好几秒，而宽高在前 10 个字节里。不转这个头
                            // 的话，想在渲染前知道尺寸就只能把整张图下完。
                            let mut request = client.get(target_url);
                            if let Some(range) = range.as_deref() {
                                request = request.header("Range", range);
                            }
                            match request.send().await {
                                Ok(response) => {
                                    // 协商头要在动 body 之前抄下来：下面把 response 交给
                                    // bytes_stream() 之后就只剩这条流，拿不到 headers 了
                                    let upstream_headers = response.headers().clone();

                                    let status = warp::http::StatusCode::from_u16(response.status().as_u16()).unwrap();
                                    let mut res = warp::http::Response::builder().status(status);

                                    // 上游的 body 一条条往下转，不在本地攒完再发。以前这里是
                                    // response.bytes().await —— 整张图下载完之前一个字节都不
                                    // 回给 webview，于是 <img> 只能等到底才出图：实测一张
                                    // 763KB 的 QQ 表情在本地环回上要 6.3s 才 TTFB，用户看到
                                    // 的就是一块空白挂六秒。图片是流式的，浏览器拿到一段就
                                    // 能画一段（GIF / 基线 JPEG 都是），改成转发之后首像素
                                    // 跟着首字节到，同一张图 0.2s 内就开始出画面。
                                    //
                                    // 这条不影响「不抖动」：占位框的尺寸是前端另走 Range 探针
                                    // 拿的（msgUtil.probeImageSize），跟这里发多少无关；流式只
                                    // 改变盒子内部什么时候有像素，不改变盒子多大。
                                    //
                                    // 上游中途断了就是断在流里，客户端拿到的是截断的 body（和
                                    // 任何网络中断一样，浏览器自己会当解码失败处理），不再像
                                    // 以前那样整段失败后回一个干净的 502。
                                    let body = warp::hyper::Body::wrap_stream(response.bytes_stream());

                                    res = res
                                        .header("Access-Control-Allow-Origin", "*")
                                        .header("X-Frame-Options", "");

                                    // 上游的 Content-Type 原样透传，不能写死。以前这里是
                                    // text/html; charset=utf-8 —— 不分资源类型，代理对每一张
                                    // 图片都宣称自己是网页。<img> 那边靠内容嗅探照样能出图，
                                    // 所以一直没暴露；可这个头是会被下游当真的：
                                    // localHistoryUtil.downloadImageViaProxy 拿它当图片的 MIME
                                    // 存进本地库，MsgBody 再拼成 data:text/html;base64,...
                                    // （data: URL 不做嗅探，声明什么就是什么），本地缓存过的
                                    // 图片因此可能整片打不开。
                                    // 代理的职责是转发而不是发明类型，上游没给就说
                                    // application/octet-stream（与 assets 分支一致），绝不猜成 html。
                                    let content_type = upstream_headers
                                        .get("Content-Type")
                                        .and_then(|value| value.to_str().ok())
                                        .unwrap_or("application/octet-stream")
                                        .to_string();
                                    res = res.header("Content-Type", content_type);

                                    // 把上游的缓存协商头透传下去。以前这里是空的，浏览器
                                    // 手上既没有 Cache-Control 也没有 ETag / Last-Modified，
                                    // 就没有任何东西可以拿来复用这个响应，只能把每一个 <img>
                                    // 都当成新请求，重新走一遍 代理 -> CDN 的完整往返。而聊天
                                    // 图片恰恰是同一张 URL 反复出现（预加载之后真正的 <img>、
                                    // 来回切会话、重开应用），每一次都从头下一遍。
                                    //
                                    // 走 as_bytes 而不是直接传 HeaderValue：reqwest 依赖 http
                                    // 1.x、warp 依赖 http 0.2，两边的 HeaderValue 是不同的类型，
                                    // 中间只能靠字节裸转。
                                    //
                                    // Content-Length 也在里面：body 现在是流式的，不显式带上
                                    // 它，warp 就只能用 chunked 编过去 —— 图片本身没影响，但
                                    // 一个没有长度的响应浏览器很难当完整对象缓存下来，等于
                                    // 把上面那批缓存头白透传了。
                                    for name in ["Cache-Control", "ETag", "Last-Modified", "Expires", "Age", "Content-Range", "Accept-Ranges", "Content-Length"] {
                                        if let Some(value) = upstream_headers.get(name) {
                                            res = res.header(name, value.as_bytes().to_vec());
                                        }
                                    }

                                    Ok::<_, Infallible>(res.body(body).into_response())
                                }
                                Err(_) => Ok::<_, Infallible>(
                                    warp::reply::with_status("请求失败", warp::http::StatusCode::BAD_GATEWAY)
                                        .into_response(),
                                ),
                            }
                        } else {
                            Ok::<_, Infallible>(
                                warp::reply::with_status("未知的 URL", warp::http::StatusCode::BAD_REQUEST)
                                    .into_response(),
                            )
                        }
                    }
                }});

        let assets_filter = warp::path("assets")
            .and(warp::query::<HashMap<String, String>>())
            .and_then({
                let client = assets_client;
                move |params: HashMap<String, String>| {
                    let client = client.clone();
                    async move {
                        if let Some(target_url) = params.get("url") {
                            match client.get(target_url).send().await {
                                Ok(response) => {
                                    let content_type = response
                                        .headers()
                                        .get("Content-Type")
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("application/octet-stream")
                                        .to_string();

                                        let res = warp::http::Response::builder()
                                        .status(warp::http::StatusCode::from_u16(response.status().as_u16()).unwrap());

                                    let body = response.bytes().await.unwrap_or_default();

                                    let res = res
                                        .header("Content-Type", content_type)
                                        .header("Access-Control-Allow-Origin", "*");

                                    Ok::<_, Infallible>(res.body(body).into_response())
                                }
                                Err(_) => Ok::<_, Infallible>(
                                    warp::reply::with_status("请求失败", warp::http::StatusCode::BAD_GATEWAY)
                                        .into_response(),
                                ),
                            }
                        } else {
                            Ok::<_, Infallible>(
                                warp::reply::with_status(
                                    "缺少参数: url",
                                    warp::http::StatusCode::BAD_REQUEST,
                                )
                                .into_response(),
                            )
                        }
                    }
                }
            });

        let mut port = START_PORT;
        let routes = proxy_filter.or(assets_filter);

        loop {
            let addr: SocketAddr = ([127, 0, 0, 1], port).into();

            match warp::serve(routes.clone()).try_bind_ephemeral(addr) {
                Ok((_, server)) => {
                    tokio::spawn(server);
                    return Self { port };
                }
                Err(_) => {
                    port += 1;
                    if port > MAX_PORT {
                        panic!("❌ 本地反代服务无法绑定 {}-{}", START_PORT, MAX_PORT);
                    }
                }
            }
        }
    }
}
