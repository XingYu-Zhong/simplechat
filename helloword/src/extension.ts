// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('启动聊天插件');
	// 注册聊天视图提供者
	const chatProvider = new ChatViewProvider(context.extensionUri);
	const chatViewRegistration = vscode.window.registerWebviewViewProvider(
		'chatView',
		chatProvider,
		{
			// 当视图可见时保持webview内容
			webviewOptions: { retainContextWhenHidden: true }
		}
	);

	// 添加订阅到上下文中
	context.subscriptions.push(chatViewRegistration);
	
	// 确保 ChatViewProvider 实例也被添加到上下文中，以便正确处理清理
	context.subscriptions.push(chatProvider);
	
	console.log('聊天插件启动完成');
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log('聊天插件已停用');
}
