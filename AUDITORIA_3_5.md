# Auditoria backend 3.5 — Capacete Inteligente Pro

| Área | Resultado local | Limitação |
|---|---|---|
| Sintaxe do Node | Aprovado por `node --check` | Não equivale a inicialização online |
| Testes de status/horário/acesso/e-mail | 31 testes unitários aprovados | Serviços reais não exercitados |
| MQTT legado | Mantido `capacete/status` com `deviceId=default` | Requer ESP32 publicando ao vivo |
| Novos capacetes | Tópicos `capacete/<id>/status`, cadastro prévio obrigatório e dados separados | Precisa configurar novo ESP32 e vínculo no banco |
| Proteção da identidade | Divergência topic/JSON rejeitada; conta pendente não entra nos endpoints autenticados | MQTT shared publish deve ter ACL por dispositivo |
| Acesso empresarial | Cadastro fica pendente; listas e decisões exigem token de administração geral | Interface de aprovação deve ser feita/ligada |
| E-mail | Brevo HTTPS com mock de teste | Precisa conta, remetente validado e API key; entrega real não testada |
| Segredos | JSON Firebase Admin somente via variável Render | Não compartilhar variáveis privadas |
| Plano gratuito | HTTP funciona, SMTP 25/465/587 bloqueado | Hiberna; inadequado para monitoramento contínuo crítico |
| Dashboard pessoal | Dados disponíveis no Firebase quando recebidos | Integração visual não testada nem publicada |
| Publicação GitHub | Script preparado para branch isolada | Push depende de autenticação local do usuário |
| Deploy Render | Não realizado | Usuário precisa selecionar nova branch e publicar |

**Zero APK ou firmware alterado nesta etapa. Nenhuma alteração no Render/GitHub foi feita automaticamente.**
