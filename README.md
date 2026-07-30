# Char Companion（随身推送）— 前端

这是插件的酒馆扩展面板部分。完整的安装说明、推送渠道设置教程、已知问题，请看后端仓库的README：

👉 https://github.com/quellambigu/char-companion

（后端仓库里的说明包含了前端+后端的完整安装步骤，不用分开看）


## 随身推送 更新日记

### 1.1.0 前端更新角色锁
可锁定当前推送角色，并使用其他角色卡玩酒馆

### 1.2.0 后端更新飞书webhook端口
需要使用飞书PC客户端建自定义机器人，后续可使用app接收推送，不限平台

后端更新指令：

```bash
REPO=$(find /data/data/com.termux/files/home -maxdepth 8 -type d -iname "char-companion" 2>/dev/null | grep -v frontend | head -1)

if [ -z "$REPO" ]; then
  echo "[错误] 没找到char-companion文件夹，你是不是还没在本地装过后端？"
else
  echo "找到路径: $REPO"
  cd "$REPO"
  echo "--- 更新前版本 ---"
  grep version package.json
  git pull origin main
  echo "--- 更新后版本 ---"
  grep version package.json
  echo "--- 校验飞书功能是否拉到 ---"
  grep -c "feishu.cn" index.js
fi
```

### 1.2.1 前端修复刷新后角色锁失效的问题
现在刷新酒馆后角色锁会依然锁定推送角色
