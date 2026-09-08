"use client";

import { MessageSquareText, Send, X } from "lucide-react";
import { useState } from "react";
import type { FixtureScenario } from "@/presentation/state";
import { scenarioMessage } from "@/presentation/state";

export function ConversationPanel({ scenario, onClose }: { scenario: FixtureScenario; onClose: () => void }) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const status = scenarioMessage(scenario);

  return (
    <aside className="conversation-panel" aria-label="规划对话" data-testid="conversation-panel">
      <header className="panel-header">
        <div><MessageSquareText aria-hidden="true" size={18} /><strong>规划对话</strong></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="收起规划对话" title="收起对话"><X aria-hidden="true" size={18} /></button>
      </header>
      <div className="conversation-body">
        <div className="message user-message">想去北京玩三天，偏爱历史文化。</div>
        <div className="message assistant-message">
          已载入北京三日演示版本。时间、路线与资料均为固定夹具，尚未连接实时服务。
        </div>
        {status && <div className={`run-status ${scenario}`} role="status"><span className="status-dot" />{status}</div>}
        {submitted && (
          <>
            <div className="message user-message">{submitted}</div>
            <div className="message assistant-message">当前阶段不支持任意对话生成行程。你可以使用行程中的演示编辑控件。</div>
          </>
        )}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); const value = text.trim(); if (!value) return; setSubmitted(value); setText(""); }}>
        <label className="sr-only" htmlFor="fixture-message">输入规划消息</label>
        <textarea id="fixture-message" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入规划想法" rows={2} />
        <button className="icon-button send-button" type="submit" aria-label="发送演示消息" title="发送" disabled={!text.trim()} data-testid="send-message-button"><Send aria-hidden="true" size={17} /></button>
      </form>
      <p className="fixture-footnote">固定演示 · 不会调用模型</p>
    </aside>
  );
}
