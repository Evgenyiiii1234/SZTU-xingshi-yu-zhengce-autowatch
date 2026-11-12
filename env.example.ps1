# 大模型成稿用（可选）。在 PowerShell 里 dot-source 一下：
#   . .\env.example.ps1
# 然后 python pipeline\summarize.py "out\第3讲.md" 就会自动出 -summary.md

$env:SUM_BASE  = "https://api.deepseek.com/v1"
$env:SUM_KEY   = "sk-换成你自己的"
$env:SUM_MODEL = "deepseek-chat"

# 其它兼容 OpenAI 接口的服务，改这三行就行，例如：
# $env:SUM_BASE  = "https://dashscope.aliyuncs.com/compatible-mode/v1"
# $env:SUM_MODEL = "qwen-plus"
# $env:SUM_BASE  = "https://api.moonshot.cn/v1"
# $env:SUM_MODEL = "moonshot-v1-32k"

# HuggingFace 直连不通时，取消注释走镜像（transcribe.py 也会自动重试一次）
# $env:HF_ENDPOINT = "https://hf-mirror.com"
