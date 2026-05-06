## 🚀 BingoCode Installation Guide

### **Step 1: Check Environment**
First, we need to verify if **npm** is already installed on your computer.
* Open your terminal (CMD or PowerShell) and enter the following command:
```bash
npm -v
```
> **Results:**
> * ✅ If a version number appears (e.g., `10.x.x`), skip to **Step 3**.
> * ❌ If you see "not recognized as an internal or external command," proceed to **Step 2**.

---

### **Step 2: Install NodeJS/npm**
If the environment is missing, you can quickly install it via the Windows Package Manager:
1.  Run the installation command:
    ```bash
    winget install OpenJS.NodeJS.LTS
    ```
2.  **Important:** Once the installation is complete, you **must close all current CMD windows and reopen them** for the environment variables to take effect.

---

### **Step 3: Install BingoCode**
With the environment ready, install the tool globally:
```bash
npm install -g bingocode
```

---

### **Step 4: Start BingoCode Service**
After installation, you need to launch the local backend service:
1.  In the terminal, enter:
    ```bash
    bingo
    ```
2.  **Key Point:** Once the service starts, **keep this window open**. Closing the window will cause the plugin features to stop working.

---

### **Step 5: Configure Model Provider**
Now we need to connect a "brain" to BingoCode:
1.  Open the BingoCode interface, go to **API Configuration** -> click **Add Provider**.
2.  Select **Deepseek** (or any other AI provider you use).
3.  Enter your **API Key**.
4.  Click **Connectivity Test**.
    > ✅ **Note:** Configuration is successful only when it displays "Normal" or "Passed."

---

### **Step 6: Configure Slots**
To ensure high-quality code generation, you must complete the slot mapping:
1.  Navigate to the **Slot Configuration** interface.
2.  **Core Requirement:** It is recommended to configure all **4 slots**, as they correspond to different code generation logics.
3.  Ensure each slot is linked to the Provider you successfully configured in the previous step.

---

### **Step 7: Start Chatting**
Everything is set!
1.  Click **New Session**.
2.  Describe your requirements in the input box, and BingoCode will begin generating code for you.

> **CMD Shortcuts:**
```bash
bingo       # Service Console
bingocode   # Chat Window
```

---
Modified From: [https://github.com/NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)
```

## 🚀 BingoCode 安装指南

### **第一步：检查环境**
首先，我们需要确认你的电脑是否已经安装了 **npm**。
* 打开终端（CMD 或 PowerShell），输入以下命令：
```bash
npm -v
```
> **结果判断：**
> * ✅ 如果显示版本号（如 `10.x.x`），请跳至 **第三步**。
> * ❌ 如果提示“不是内部或外部命令”，请执行 **第二步**。

---

### **第二步：安装 NodeJS/npm**
如果你没有安装环境，可以通过 Windows 软件包管理器快速安装：
1.  运行安装命令：
    ```bash
    winget install OpenJS.NodeJS.LTS
    ```
2.  **重要：** 安装完成后，必须**关闭当前所有 CMD 窗口并重新打开**，环境配置才会生效。

---

### **第三步：安装 BingoCode**
环境准备就绪后，直接全局安装工具：
```bash
npm install -g bingocode
```
收到！为了保持风格统一并确保操作流程清晰，我为你补充了后续的步骤。你可以直接将以下内容接在你的指南后面：

---

### **第四步：启动 BingoCode 服务**
安装完成后，你需要启动本地服务端：
1.  在终端中输入：
    ```bash
    bingo
    ```
2.  **关键点：** 服务启动后，请**保持该窗口开启**，不要关闭。如果关闭窗口，插件功能将失效。

---

### **第五步：配置模型提供商 (Provider)**
现在我们需要给 BingoCode 接入“大脑”：
1.  打开 BingoCode 界面，进入 **API 配置** -> 点击 **新增 Provider**。
2.  选择 **Deepseek**（或你拥有的其他 AI 服务商）。
3.  填写你的 **API Key**。
4.  点击 **连通性测试**。
    > ✅ **注意：** 只有显示“正常”或“通过”，才代表配置成功。

---

### **第六步：配置插槽 (Slots)**
为了确保生成的代码质量，需要完成槽位映射：
1.  进入 **槽位配置** 界面。
2.  **核心要求：** 这里的 **4 个槽位** 建议全部完成配置，分别对应不同的代码生成逻辑。
3.  确保每个槽位都关联到了你刚刚配置成功的 Provider。

---

### **第七步：开启对话**
一切就绪！
1.  点击 **新建会话**。
2.  在输入框中描述你的需求，BingoCode 将开始为你生成代码。

> CMD快捷键：
```bash
bingo       #服务台
bingocode   #聊天窗口
```


Modified Form ：https://github.com/NanmiCoder/cc-haha
