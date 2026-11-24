const messages = document.querySelector('#messages');
const input = document.querySelector('#message');
const sendButton = document.querySelector('#send');
const status = document.querySelector('#status');
const clientKey = 'tube-chat-client-id';
let clientId = localStorage.getItem(clientKey);
if (!clientId) {
  clientId = crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
    });
  localStorage.setItem(clientKey, clientId);
}
let isSending = false;

function addMessage(text, kind) {
  const node = document.createElement('div');
  node.className = `message ${kind}`;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
}

async function request(url, payload) {
  const response = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

function addChoices(choices) {
  const group = document.createElement('div');
  group.className = 'choices';
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    button.addEventListener('click', async () => {
      for (const option of group.querySelectorAll('button')) option.disabled = true;
      await sendMessage(choice.message, choice.label);
    });
    group.append(button);
  }
  messages.append(group);
  messages.scrollTop = messages.scrollHeight;
  return group;
}

async function sendMessage(text, displayText = text) {
  if (!text || isSending) return;
  isSending = true;
  addMessage(displayText, 'user');
  input.value = '';
  sendButton.disabled = true;
  for (const option of document.querySelectorAll('.choices button')) option.disabled = true;
  status.textContent = 'Thinking…';
  let newChoiceGroup = null;
  try {
    const result = await request('/api/chat', { message: text, clientId });
    addMessage(result.reply, 'bot');
    if (result.choices?.length) newChoiceGroup = addChoices(result.choices);
  } catch (e) { addMessage(e.message, 'bot'); }
  finally {
    isSending = false;
    sendButton.disabled = false;
    if (newChoiceGroup) {
      for (const option of newChoiceGroup.querySelectorAll('button')) option.disabled = false;
    }
    status.textContent = 'Connected';
    input.focus();
  }
}

request('/api/info').then((info) => {
  const nav = document.querySelector('#addresses');
  if (!info.addresses.length) {
    const local = document.createElement('a');
    local.href = `${info.scheme}://localhost:${info.port}`;
    local.textContent = local.href;
    nav.append(local);
    return;
  }
  for (const item of info.addresses) {
    const link = document.createElement('a');
    link.href = `${info.scheme}://${item.address}:${info.port}`;
    link.textContent = item.address;
    link.title = `Open via ${item.interface}: ${link.href}`;
    nav.append(link);
  }
}).catch(() => { status.textContent = 'Server info unavailable'; });

document.querySelector('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendMessage(input.value.trim());
});

addMessage('Hi! I can queue YouTube downloads and manage channel subscriptions. Type /help to see the commands.', 'bot');
