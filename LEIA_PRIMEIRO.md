# CORRECAO ERRO 403 GITHUB (3.5.2)

**Comece por `1_CORRIGIR_GITHUB_403_E_PUBLICAR.cmd`.** A falha 403 nao e erro do backend: a conta do Windows nao tem permissoes de escrita no GitHub da empresa. Consulte `COMO_RESOLVER_403.txt`.

# CAPACETE INTELIGENTE PRO — Backend Render 3.5.1 (vários capacetes — publicador Windows corrigido)

Este é o **backend** para o novo Render, NÃO é APK e NÃO substitui o aplicativo ou o site.

## O que já está implementado

- MQTT TLS: preserva o ESP32 atual (`capacete/status`, device `default`) e recebe novos em `capacete/<deviceId>/status`;
- separa status, eventos e resumo em `devices/<deviceId>/...` e `companies/<companyId>/monitoring/...`;
- ignora ID não cadastrado, desativado e tentativa de passar outro ID no JSON do tópico;
- `DETECTOU` → ATIVO / `LIVRE` → INATIVO; jornada pode resultar em PAUSA e FORA_JORNADA; ausência de comunicação aparece como offline nos aplicativos;
- `POST /company/devices/link` para um administrador vincular placa e capacete registrados, sem criar novas configurações técnicas no app Empresa;
- solicitação empresarial com validação de Firebase ID Token: `POST /access-requests/register`, `GET /access-requests/status`, `GET /platform/access-requests`, `POST /platform/access-requests/:uid/decision`;
- envio de e-mail via **API HTTPS Brevo** para planos gratuitos Render (SMTP 25/465/587 é bloqueado);
- Mary IA: rota `POST /mary/chat` preservada; seu funcionamento depende de chave/modelo configurados no servidor.

## IMPORTANTE: os 7 campos já preenchidos no Render

O serviço aceita `FIREBASE_SERVICE_ACCOUNT_JSON`, com esse nome exato. Mantenha os demais como estão (MQTT_HOST, MQTT_PORT, MQTT_TOPIC, MQTT_USER, MQTT_PASS, FIREBASE_DATABASE_URL). Sem precisar duplicar chaves.

Adicione ao Render **quando configurar e-mail**:
- `BREVO_API_KEY`: chave de API obtida na conta Brevo, inserida **diretamente no Render**;
- `BREVO_SENDER_EMAIL`: remetente VERIFICADO no Brevo;
- `APPROVAL_ADMIN_EMAIL`: e-mail do dono já preenchido, também associado à conta administradora verificada no Firebase Auth.

Se as variáveis do Brevo não existirem, a API de cadastro retorna erro 503 **sem conceder acesso**. O monitoramento MQTT pode ser testado separadamente. Não use exemplos como valores reais.

## Como instalar sem tocar no backend antigo

1. Extraia este ZIP em pasta nova no seu Windows.
2. Entre na pasta `CAPACETE_BACKEND_PRO_3_5_1_WINDOWS_CORRIGIDO`, execute `VERIFICAR_BACKEND.cmd` e depois `PUBLICAR_BRANCH_GITHUB.cmd`.
   - O CMD chama o PowerShell de forma controlada, testa o Node.js, clona o GitHub e confirma as alterações antes do envio.
   - Guarda o resultado em `Área de Trabalho/CAPACETE_BACKEND_PUBLICACAO/RESULTADO_GITHUB_*.txt`.
   - **Requer Git para Windows e uma sessão do GitHub com permissão para enviar commits**. Se faltar autenticação, o erro aparecerá no relatório.
   - Só digite `PUBLICAR` depois de conferir a branch e a lista de arquivos.
3. O CMD exige `git` instalado e login no GitHub; cria/atualiza **somente a branch `render-pro-multicapacetes`** do repositório já conectado; mostra os arquivos que mudará e exige confirmação escrita `PUBLICAR` antes do push.
4. **No formulário do NOVO Render, mude o campo Branch de `main` para `render-pro-multicapacetes`.** Não faça deploy da branch main.
5. Build Command: `npm install` · Start Command: `npm start` · Instance Type: Free; Runtime Node.
6. Só clique Deploy depois de garantir que ele usará essa branch e que as credenciais estão salvas. Depois confira `/health` e `/access-requests/health`.

GitHub com contas/credenciais privadas: **não inclua o JSON privado, .env real, senhas ou tokens em commits**.

## Quando adicionar o próximo capacete

- No **Capacete Empresa**, cadastrar capacete e funcionário/obra normalmente; nenhum campo de versão da placa.
- No **Meu Capacete**, fazer a configuração física ESP32/sensor e definir ID exclusivo, por exemplo `cap-002`.
- Administrador da empresa associa `deviceId=cap-002` ao `helmetId` existente pelo endpoint autenticado `/company/devices/link` (ou por futuro assistente de pareamento).
- O ESP32 publica `DETECTOU`/`LIVRE` em `capacete/cap-002/status`.
- O mesmo Firebase mostra leituras separadas nos aplicativos e, após integrar as telas, no painel pessoal. **Esta entrega modifica somente o backend**, não instala firmware novo nem atualiza visual/funcionalidades do painel pessoal.
- Configurar no HiveMQ permissões de publicação por dispositivo ou uma credencial separada por equipamento; identificadores em tópicos não bastam como autenticação criptográfica individual.

## Administração e aprovação

- Para aprovar, a conta precisa existir no Firebase Authentication, estar com e-mail verificado, coincidir com `APPROVAL_ADMIN_EMAIL` e possuir `users/{uid}/profile` com `enabled:true` e `platformAdmin:true`, além de `authorizedUsers/{uid}/enabled:true`.
- A **primeira preparação desse administrador** exige ação confiável pelo Firebase Admin SDK ou console, antes de tentar a aprovação. Existe `scripts/bootstrap-platform-admin.js`, para rodar **somente em computador seguro com credencial administrativa**, nunca no cliente.
- As rotas administrativas exigem Firebase ID token; uma solicitação pendente não autoriza acesso, inclusive se a conta conseguir autenticar no Firebase Auth.
- Não basta responder ao e-mail: a aprovação precisa ocorrer por uma interface administrativa autenticada que chame `/platform/access-requests/:uid/decision`. A interface visual de aprovação ainda precisa ser integrada ao dashboard.

## Limitações honestas

- O Render **Free hiberna** por inatividade e pode interromper MQTT/monitoramento contínuo. Não usar como única camada em sistema de proteção real nem garantir SLA de segurança.
- Integração ponta a ponta com ESP32/HiveMQ, Firebase real, e-mail real, aplicativos e dashboard **não executada** nesta entrega.
- O projeto inclui regras RTDB como referência, mas **NÃO publicá-las automaticamente**. Auditar permissões reais antes de qualquer atualização; alterações erradas podem bloquear as pessoas já autorizadas.
- Os 31 testes disponíveis validam bibliotecas puras (incluindo registros de novos dispositivos e e-mail HTTPS) e sintaxe. Não verificam entrega de e-mail nem o estado online do Render.

## Correção específica 3.5.1 — Windows

O antigo `.cmd` estava em LF (Unix), causando erros como `'cho'`, `'oto'` e `'errorlevel'` ao ser executado pelo CMD do Windows. Os iniciadores foram reescritos em ASCII com terminações CRLF. O publicador usa `PUBLICAR_BRANCH_GITHUB.ps1` (PowerShell) para evitar ambiguidade de interpretação de parênteses e caracteres especiais do Windows. **O código do backend e o Firebase não foram alterados nesta correção.** O script não faz deploy no Render, e `main` permanece intocada.

Verificação local do pacote: `npm run check` e `npm test` com 31 testes passando no Node.js 22. A execução do publicador no Windows e o push autenticado ao GitHub precisam ser confirmados no seu computador.
