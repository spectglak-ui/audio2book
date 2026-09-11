import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css"; // 👈 Indispensable pour que les styles s'appliquent

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);