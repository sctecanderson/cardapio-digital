# Cardápio Digital — Fase 6

Base React + Vite + TypeScript + Tailwind CSS + React Router.
Este pacote é a estrutura inicial, não o cardápio completo dos mockups.

## Executar no Windows / PowerShell

Instale uma versão LTS compatível do Node.js (recomendado Node 24).
Abra a pasta do projeto e execute:

```powershell
npm.cmd ci
npm.cmd run dev
```

Abra o endereço informado pelo terminal. Para verificar a compilação:

```powershell
npm.cmd run build
```

## Validar esta etapa

- `/`: escolha entre NOMA e BRASA.
- `/noma` e `/brasa`: identidade carregada por configuração.
- `/noma/explorar`: rota reservada para a Fase 8.
- `/noma/acesso`: explicação do acesso ainda não integrado.
- Restaurante inexistente: mensagem de erro.
- Voltar/avançar do navegador: navegação entre rotas.

## Limites deliberados

Não há banco, login real, produtos, chamados, comandas, vídeos ou identificação validada de mesa.
Um parâmetro como `?mesa=07` não libera atendimento. A interface apresenta consulta sem mesa.
As rotas operacionais redirecionam para acesso; isso não substitui a futura autorização no servidor.
Não há chaves nem credenciais no projeto. Publicação permanece para a fase de deploy.

## Organização

- `src/app`: rotas e estrutura visual.
- `src/data`: dados demonstrativos dos restaurantes.
- `src/types`: contratos TypeScript.
- `src/styles.css`: base visual e Tailwind.

Próxima etapa: Fase 7, cardápio, categorias, busca e detalhes, preservando a estrutura.
