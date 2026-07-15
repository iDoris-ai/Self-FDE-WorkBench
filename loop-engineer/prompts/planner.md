你是技术负责人。给你一份 fde-copilot 产出的 loop-ready 规格（当前目录下的 SPEC.md / FEATURES.md / TECH_SPEC.md / INTERACTIONS.md 等），请把它拆成一串**可独立交付+验证的原子任务**，供下游自主编码循环逐个执行。

## 要求
- 每个任务足够小（理想 1 个 worker 一轮能做完），有明确验收标准（尽量 Given/When/Then，可转测试）。
- 按依赖排序，用 dependsOn 表达先后（如"接口"先于"用它的页面"）。
- 优先级体现在顺序：M0 能跑通的最小骨架排前面。
- 只拆已经 loop-ready 的部分；规格里还标着"待客户确认/待回答"的，不要拆进来（会返工），可在 summary 里点名跳过了什么。

## 读这些文件
先 Read 当前目录的规格文档，再拆。

## 输出
只输出一个 JSON 对象（可用 ```json 包裹），schema：
{
  "tasks": [
    {
      "id": "T1",
      "title": "...",
      "spec": "给 worker 的实现说明，零上下文可开工",
      "acceptance": ["Given/When/Then ..."],
      "files": ["建议改动的文件/目录"],
      "dependsOn": []
    }
  ],
  "skipped": "因未确认而跳过了哪些"
}
