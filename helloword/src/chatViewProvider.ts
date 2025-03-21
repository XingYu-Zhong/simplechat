import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    model?: string;
}

/**
 * 聊天视图提供者
 * 实现侧边栏的聊天视图
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'chatView';
    private _views: Map<string, vscode.WebviewView> = new Map();
  private openai?: OpenAI;
    private messagesMap: Map<string, ChatMessage[]> = new Map();
    private historyLimit: number = 5;
    private _configPanel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {
        // 注册命令
        this._disposables.push(
            vscode.commands.registerCommand('chatView.newChat', () => {
                console.log('新建聊天命令被触发');
                this.startNewChat();
            }),

            vscode.commands.registerCommand('chatView.openConfig', () => {
                this.openConfig();
            })
        );
    }

    /**
     * 处理 WebView 消息
     */
    private async handleMessage(message: any, viewId: string, webview: vscode.Webview) {
        switch (message.command) {
            case 'sendMessage':
                try {
                    if (!await this.checkConfig()) {
                        webview.postMessage({ 
                            command: 'receiveReply', 
                            text: '请先完成配置后再发送消息' 
                        });
                        return;
                    }

                    const messages = this.messagesMap.get(viewId) || [];
                    
                    // 添加用户消息
                    const userMessage: ChatMessage = {
                        role: 'user',
                        content: message.text,
                        timestamp: new Date().toISOString(),
                        model: message.model
                    };
                    messages.push(userMessage);

                    // 发送到 OpenAI
                    const reply = await this.sendToOpenAI(message.text, message.model, messages);
                    
                    // 添加助手消息
                    const assistantMessage: ChatMessage = {
                        role: 'assistant',
                        content: reply,
                        timestamp: new Date().toISOString(),
                        model: message.model
                    };
                    messages.push(assistantMessage);
                    
                    webview.postMessage({
                        command: 'updateStatus',
                        status: 'ready'
                    });
                    webview.postMessage({ 
                        command: 'receiveReply', 
                        text: reply
                    });
                } catch (error) {
                    webview.postMessage({
                        command: 'updateStatus',
                        status: 'error'
                    });
                    webview.postMessage({ 
                        command: 'receiveReply', 
                        text: '发生错误：' + (error instanceof Error ? error.message : '未知错误')
                    });
                }
                break;

            case 'getConfig':
                const config = vscode.workspace.getConfiguration('chatPlugin');
                webview.postMessage({
                    command: 'setConfig',
                    config: {
                        apiKey: config.get('apiKey'),
                        baseUrl: config.get('baseUrl'),
                        historyLimit: config.get('historyLimit') || 5
                    }
                });
                break;

            case 'saveConfig':
                await this.saveConfig(message.config);
                break;

            case 'modelChanged':
                this.messagesMap.set(viewId, []);
                break;

            case 'startNewChat':
                // 重置当前会话的消息历史
                console.log('收到前端startNewChat消息');
                this.messagesMap.set(viewId, []);
                break;
        }
    }

  /**
   * 初始化 OpenAI 客户端
   */
  private initOpenAI() {
    const config = vscode.workspace.getConfiguration('chatPlugin');
    const apiKey = config.get<string>('apiKey');
    const baseURL = config.get<string>('baseUrl');

    if (apiKey) {
      this.openai = new OpenAI({
        baseURL,
        apiKey,
        defaultHeaders: {
          'HTTP-Referer': 'https://vscode-chat-extension.com',
          'X-Title': 'VSCode Chat Plugin',
        },
      });
    }
  }

    /**
     * 初始化配置
     */
    private initConfig() {
        const config = vscode.workspace.getConfiguration('chatPlugin');
        this.historyLimit = config.get('historyLimit') || 5;
    }

  /**
   * 检查配置是否完整
   */
  private async checkConfig(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('chatPlugin');
    const apiKey = config.get('apiKey');
    
    if (!apiKey) {
      const result = await vscode.window.showWarningMessage(
        '请先配置 API Key',
        '去配置'
      );
      
      if (result === '去配置') {
        // 切换到配置标签
                this._views.forEach(view => {
                    view.webview.postMessage({ command: 'switchToConfig' });
                });
      }
      return false;
    }
    return true;
  }

  /**
   * 发送消息到 OpenAI
   */
    private async sendToOpenAI(
        userMessage: string, 
        model: string = 'deepseek/deepseek-r1-zero:free',
        messages: ChatMessage[]
    ): Promise<string> {
        try {
      if (!this.openai) {
        this.initOpenAI();
      }

      if (!this.openai) {
        throw new Error('OpenAI client not initialized');
      }

      // 添加用户消息到历史
            messages.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });

            // 如果历史记录超过限制，删除最早的对话轮次
            while (messages.length > this.historyLimit * 2) {
                messages.splice(0, 2);
            }

            console.log('\n=== 用户输入 ===');
            console.log('时间:', new Date().toLocaleString());
            console.log('模型:', model);
            console.log('内容:', userMessage);
            console.log('当前对话轮数:', Math.floor(messages.length / 2));

            console.log('\n=== 开始请求 API ===');
            const startTime = Date.now();
            
      const stream = await this.openai.chat.completions.create({
                model: model,
                messages: messages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                })),
        stream: true,
        temperature: 0.7,
        max_tokens: 1000
      });

      let fullResponse = '';
      
      for await (const chunk of stream) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          fullResponse += content;
          
                    this._views.forEach(view => {
                        view.webview.postMessage({
            command: 'receiveStreamChunk',
            chunk: content
                        });
          });
        }
      }

            const endTime = Date.now();
            console.log('\n=== AI 响应 ===');
            console.log('时间:', new Date().toLocaleString());
            console.log('耗时:', (endTime - startTime) / 1000, '秒');
            console.log('内容:', fullResponse);
            console.log('\n=== 会话结束 ===\n');

            messages.push({ role: 'assistant', content: fullResponse, timestamp: new Date().toISOString() });

      return fullResponse;
    } catch (error) {
            console.error('\n=== 错误日志 ===');
            console.error('时间:', new Date().toLocaleString());
            console.error('错误详情:', error);
      
      if (error instanceof Error) {
        const errorMessage = error.message;
        if (errorMessage.includes('401')) {
          return '错误：API Key 无效或已过期，请检查配置';
        } else if (errorMessage.includes('429')) {
          return '错误：API 请求过于频繁，请稍后再试';
        } else if (errorMessage.includes('model')) {
          return '错误：模型不可用或不存在，请检查配置';
        } else if (errorMessage.includes('insufficient_quota')) {
          return '错误：API 配额不足';
        }
        return `错误：${errorMessage}`;
      }
      
      return '发生未知错误，请稍后重试';
    }
  }

  /**
   * 获取WebView的HTML内容
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    
    // 确保 CSP 允许执行内联脚本
    const nonce = this._getNonce();
    html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    
    // 添加 CSP
    const csp = `
      <meta http-equiv="Content-Security-Policy" content="default-src 'none';
        style-src ${webview.cspSource} 'unsafe-inline';
        script-src 'nonce-${nonce}';
        img-src ${webview.cspSource} https:;">`;
    
    // 在 head 标签后插入 CSP
    html = html.replace('</head>', `${csp}\n</head>`);
    
    return html;
  }

  /**
   * 生成随机 nonce
   */
  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

    /**
     * 打开配置页面
     */
    private openConfig() {
        if (this._configPanel) {
            this._configPanel.reveal();
            return;
        }

        this._configPanel = vscode.window.createWebviewPanel(
            'chatConfig',
            '聊天配置',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._configPanel.webview.html = this._getConfigHtmlForWebview(this._configPanel.webview);

        this._configPanel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'getConfig':
                    const config = vscode.workspace.getConfiguration('chatPlugin');
                    this._configPanel?.webview.postMessage({
                        command: 'setConfig',
                        config: {
                            apiKey: config.get('apiKey'),
                            baseUrl: config.get('baseUrl'),
                            historyLimit: config.get('historyLimit') || 5
                        }
                    });
                    break;

                case 'saveConfig':
                    await this.saveConfig(message.config);
                    break;

                case 'showError':
                    vscode.window.showErrorMessage(message.message);
                    break;
            }
        });

        this._configPanel.onDidDispose(() => {
            this._configPanel = undefined;
        });
    }

    /**
     * 获取配置页面的HTML内容
     */
    private _getConfigHtmlForWebview(webview: vscode.Webview): string {
        const configHtmlPath = path.join(this._extensionUri.fsPath, 'src', 'webview', 'config.html');
        let html = fs.readFileSync(configHtmlPath, 'utf-8');
        
        // 确保 CSP 允许执行内联脚本
        const nonce = this._getNonce();
        html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
        
        // 添加 CSP
        const csp = `
            <meta http-equiv="Content-Security-Policy" content="default-src 'none';
                style-src ${webview.cspSource} 'unsafe-inline';
                script-src 'nonce-${nonce}';
                img-src ${webview.cspSource} https:;">`;
        
        // 在 head 标签后插入 CSP
        html = html.replace('</head>', `${csp}\n</head>`);
        
        return html;
    }

    /**
     * 保存配置
     */
    private async saveConfig(config: { apiKey: string, baseUrl: string, historyLimit: number }) {
        const { apiKey, baseUrl, historyLimit } = config;
        await vscode.workspace.getConfiguration('chatPlugin').update('apiKey', apiKey, true);
        await vscode.workspace.getConfiguration('chatPlugin').update('baseUrl', baseUrl, true);
        await vscode.workspace.getConfiguration('chatPlugin').update('historyLimit', historyLimit, true);
        
        // 更新历史记录限制
        this.historyLimit = historyLimit;
        
        // 重新初始化 OpenAI 客户端
        this.initOpenAI();
        
        // 清空所有会话的消息历史
        this.messagesMap.clear();
        
        // 显示成功消息
        vscode.window.showInformationMessage('配置已保存');
        
        // 关闭配置面板
        this._configPanel?.dispose();
    }

    /**
     * 开始新的聊天
     */
    private startNewChat() {
        console.log('执行startNewChat方法，当前视图数量:', this._views.size);
        
        // 如果没有活动视图，不做任何操作
        if (this._views.size === 0) {
            console.log('没有活动的视图，无法创建新聊天');
            return;
        }
        
        try {
            // 通知前端重置界面
            this._views.forEach((view, viewId) => {
                console.log('处理视图:', viewId);
                
                if (!view.visible) {
                    console.log('视图不可见，跳过');
                    return;
                }
                
                // 只需重置该会话的消息历史，无需更改视图ID
                this.messagesMap.set(viewId, []);
                
                // 通知前端重置界面
                console.log('发送startNewChat消息到前端');
                view.webview.postMessage({ command: 'startNewChat' });
            });
        } catch (error) {
            console.error('新建聊天时出错:', error);
            vscode.window.showErrorMessage('新建聊天时出错: ' + (error instanceof Error ? error.message : '未知错误'));
        }
    }

    /**
     * 创建新的聊天视图
     */
    private async createNewChatView(initialMessages?: ChatMessage[], existingViewId?: string) {
        // 使用现有的viewId或生成新的
        const viewId = existingViewId || `chatView-${Date.now()}`;
        
        // 创建新的 WebviewPanel
        const panel = vscode.window.createWebviewPanel(
            ChatViewProvider.viewType,
            '聊天',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        // 初始化消息历史
        if (initialMessages) {
            this.messagesMap.set(viewId, [...initialMessages]);
        } else {
            this.messagesMap.set(viewId, []);
        }

        // 设置 WebView 内容
        panel.webview.html = this._getHtmlForWebview(panel.webview);

        // 处理消息
        panel.webview.onDidReceiveMessage(async message => {
            await this.handleMessage(message, viewId, panel.webview);
        });

        // 处理面板关闭
        panel.onDidDispose(() => {
            // 删除会话
            this.messagesMap.delete(viewId);
        });

        // 如果有初始消息，则恢复到界面上
        if (initialMessages && initialMessages.length > 0) {
            // 等待一段时间确保 WebView 已完全加载
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 恢复消息到界面
            for (const msg of initialMessages) {
                panel.webview.postMessage({
                    command: 'receiveReply',
                    text: msg.content,
                    role: msg.role
                });
            }
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ) {
        // 使用 webviewView 的唯一标识符作为 viewId
        const viewId = `chatView-${Date.now()}`;
        this._views.set(viewId, webviewView);
        
        this.initConfig();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 初始化消息历史
        if (!this.messagesMap.has(viewId)) {
            this.messagesMap.set(viewId, []);
        }

        webviewView.webview.onDidReceiveMessage(async message => {
            await this.handleMessage(message, viewId, webviewView.webview);
        });

        webviewView.onDidDispose(() => {
            this._views.delete(viewId);
            this.messagesMap.delete(viewId);
        });

        this.initOpenAI();
    }

    /**
     * 处理资源释放
     */
    dispose() {
        // 释放所有注册的命令
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
        
        // 关闭所有面板
        if (this._configPanel) {
            this._configPanel.dispose();
        }
    }
} 