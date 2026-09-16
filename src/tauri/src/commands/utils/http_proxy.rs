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
            .and_then({
                let client = ptoxy_client;
                move |params: HashMap<String, String>| {
                    let client = client.clone();
                    async move {
                        if let Some(target_url) = params.get("url") {
                            match client.get(target_url).send().await {
                                Ok(response) => {
                                    // 协商头要在读 body 之前抄下来：response.bytes() 会把
                                    // response 整个消耗掉，之后就拿不到 headers 了
                                    let upstream_headers = response.headers().clone();

                                    let mut res = warp::http::Response::builder()
                                        .status(warp::http::StatusCode::from_u16(response.status().as_u16()).unwrap());

                                    let body = response.bytes().await.unwrap_or_default();

                                    res = res
                                        .header("Access-Control-Allow-Origin", "*")
                                        .header("X-Frame-Options", "")
                                        .header("Content-Type", "text/html; charset=utf-8");

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
                                    for name in ["Cache-Control", "ETag", "Last-Modified", "Expires", "Age"] {
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
