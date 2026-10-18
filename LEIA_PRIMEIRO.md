# BACKEND CAPACETE 3.5.3 — Habilitar aprovações no Dashboard

**Atualize primeiro este backend; só depois publique o site 3.1.12.** Não altera a branch `main`, não altera Realtime Database nem segredos. O código do ESP32 não muda.

1. Extraia este ZIP em uma pasta nova.
2. Abra `VERIFICAR_BACKEND.cmd` e aguarde os testes.
3. Abra `PUBLICAR_BRANCH_GITHUB.cmd`, confira a branch `render-pro-multicapacetes`, confirme `PUBLICAR`.
4. No Render `capacete-backend-pro`, confira o novo deploy automático. Se Auto-Deploy estiver desligado, use `Manual Deploy > Deploy latest commit` para essa mesma branch.
5. Aguarde `Live` e confirme `/health`.
6. Só então publique o site 3.1.12 pelo seu `PUBLICAR_DASHBOARD.cmd`.

**Importante:** não exiba a chave Firebase, a senha MQTT nem BREVO_API_KEY em fotos. O backend Free não garante monitoramento ininterrupto de segurança.

O backend aceita a origem oficial Firebase Hosting; é necessário o patch CORS para a tela funcionar via navegador. A autorização continua no servidor mediante token Firebase. Dados já gravados continuam no banco. O histórico administrativo máximo exibido é 500 solicitações recentes.

Testes locais não substituem teste de e-mail real, aprovação real nem checagem das regras Firebase no projeto em produção.
