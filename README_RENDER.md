# Backend 3.5.0 — Capacete Inteligente Pro

Backend Node.js responsável por MQTT, regras de jornada, persistência do monitoramento, alertas da Mary, notificações FCM e operações administrativas que exigem Firebase Admin SDK.

## Fluxo

ESP32 -> HiveMQ MQTT/TLS -> Backend -> Firebase Realtime Database -> App Android

O backend reconhece vários dispositivos, consulta o `deviceRegistry`, resolve empresa/funcionário/capacete/obra e aplica a jornada antes de classificar a leitura.

## Variáveis obrigatórias

Consulte `.env.example`. As principais são:

- `MQTT_HOST`
- `MQTT_PORT`
- `MQTT_USER`
- `MQTT_PASS`
- `MQTT_TOPICS`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

`FIREBASE_SERVICE_ACCOUNT_JSON` deve ser o JSON da Service Account em uma variável secreta do provedor. Nunca inclua esse JSON no aplicativo ou no Git.

## Instalação e testes

```bash
npm install
npm run check
npm test
npm start
```

## Rotas administrativas

`POST /company/users` cria/vincula usuários à empresa autenticada. Somente administrador da própria empresa ou Administração Geral pode usar a rota.

`POST /platform/companies` cria uma empresa e seu administrador inicial. Exige `platformAdmin=true`.

As duas rotas validam Firebase ID Token (`Authorization: Bearer ...`).

## Bootstrap da Administração Geral

Defina `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_NAME` e, se a conta ainda não existir, `PLATFORM_ADMIN_PASSWORD`. Execute:

```bash
npm run bootstrap:platform-admin
```

## Bootstrap opcional de uma empresa

Para implantação inicial sem usar o app, configure as variáveis `BOOTSTRAP_*` descritas em `.env.example` e execute:

```bash
npm run bootstrap:company
```

## Alertas da Mary

Ao entrar no estado `INATIVO` durante jornada monitorada, o backend cria um alerta `SEM_CAPACETE` dentro da empresa e envia FCM apenas para usuários autorizados daquela empresa (além de Administração Geral, quando aplicável). Tokens inválidos são removidos automaticamente.

Almoço, pausas programadas e fora de expediente são excluídos da conformidade. Falha de comunicação é tratada como offline e não é convertida em ausência de capacete.

## Render

O `render.yaml` contém a estrutura do serviço. Credenciais marcadas como `sync: false` precisam ser cadastradas manualmente no painel do Render.

Para alertas em tempo real, o serviço precisa estar disponível quando a mensagem MQTT chegar. Planos que suspendem o processo por inatividade podem não ser adequados para uma operação de segurança que exija disponibilidade contínua.


## Mary IA online — 2.2.5

A chave da IA fica **somente no backend**. Configure no Render:

- `MARY_AI_ENABLED=true`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_SITE_URL` (opcional)

O aplicativo chama `POST /mary/chat` com o token Firebase do usuário. O backend valida a sessão e só então consulta o provedor de IA. Nenhuma chave OpenRouter é embutida no APK.


## 3.4.0 — empresas pelo próprio aplicativo

`POST /account/companies` permite que uma conta autorizada sem empresa cadastre a primeira empresa e que um administrador adicione empresas adicionais. A primeira criação associa o usuário como administrador e migra o monitoramento legado para `companies/{companyId}/monitoring/devices/default`.

## Render Free e e-mail (3.5.0)

O envio via SMTP convencional é bloqueado no Render Free; a nova integração envia solicitações pela API HTTPS do Brevo. Adicione no Render somente depois de cadastrar remetente verificado: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `APPROVAL_ADMIN_EMAIL`. Sem esses campos o cadastro fica bloqueado (503), sem autorização automática.

O ESP32 legado publica em `capacete/status`. Cada novo dispositivo usa `capacete/<id>/status` e deve estar associado em `deviceRegistry/<id>` antes de ter os dados aceitos. A sincronização do painel pessoal requer implantação/teste específico e não foi realizada neste pacote.


## Atualização 3.5.3 — Dashboard de Solicitações de Acesso

- O site aprovado `capacete-inteligente-bf599.web.app` pode consultar a API por CORS.
- A origem é verificada por igualdade exata (sem `*`).
- Autorização NÃO depende de CORS: exige Firebase ID Token da Administradora Geral, e-mail verificado e perfil `platformAdmin=true`.
- `GET /platform/access-requests?status=all` retorna pendentes, aprovadas e rejeitadas (máximo 500). Sem parâmetro mantém apenas pendentes, por compatibilidade.
- `POST /platform/access-requests/:uid/decision` continua exigindo administradora autenticada.
- A UI fica no menu `Gestão > Solicitações de acesso` da versão 3.1.12 do site.
- Para um domínio próprio futuro, defina `DASHBOARD_ALLOWED_ORIGINS` com origens HTTPS explícitas separadas por vírgula.
- O Render pode fazer deploy automático após o push, se Auto-Deploy estiver ativado; confira `Deploys` e `/health`.
