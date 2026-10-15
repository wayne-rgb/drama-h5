import '../account-link';
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import "../index.css";
import "./prototype.css";

// 复用正式页面的内容、播放、收藏、历史与设置，仅在原型入口启用手机布局。
createRoot(document.getElementById("root")!).render(<App mobilePrototype />);
