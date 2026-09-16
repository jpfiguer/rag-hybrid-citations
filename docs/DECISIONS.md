# Decisiones y bugs pagados

Lo que sigue no salió del diseño inicial. Salió de que el sistema fallara en
producción de formas que no se parecían a su causa. Están acá porque el valor
de este repositorio no es el código —son doscientas líneas— sino saber por qué
está escrito así.

---

## 1. HNSW devuelve cero resultados cuando el filtro es post-hoc

**Síntoma.** La búsqueda funcionaba con una colección cargada. Al agregar una
segunda, más grande, las consultas contra la primera empezaron a devolver cero
chunks. Sin error, sin timeout: cero filas, como si la colección estuviera
vacía.

**Causa.** El índice HNSW recorre el grafo de vecinos más cercanos y
**después** se aplica `where collection_id = X`. Si los vecinos más cercanos
del vector de consulta pertenecen a la otra colección, el filtro los descarta
todos y no queda nada. Cuanto más desbalanceadas las colecciones, más probable.

Es contraintuitivo porque la lógica de la consulta parece decir "busca dentro
de esta colección", cuando en realidad dice "busca en todo y quédate con lo de
esta colección".

**Fix.** `iterative_scan = strict_order`, de pgvector 0.8: HNSW sigue buscando
más allá de `ef_search` cuando el filtro descarta candidatos.

```sql
set local hnsw.iterative_scan = 'strict_order';
set local hnsw.max_scan_tuples = 20000;
```

Ref: [pgvector — iterative index scans](https://github.com/pgvector/pgvector#iterative-index-scans)

**La lección.** Un índice vectorial con filtro de tenant no es lo mismo que un
índice por tenant. Si el sistema es multi-colección, hay que probarlo con
colecciones de tamaños muy distintos, porque con datos parejos el bug no
aparece.

---

## 2. `SET LOCAL` no se permite en funciones `STABLE`

**Síntoma.** Al aplicar el fix anterior, la función dejó de crearse.

**Causa.** La función solo lee, así que estaba marcada `STABLE` —lo correcto
según la intuición—. Pero Postgres prohíbe `SET LOCAL` dentro de funciones
`STABLE` o `IMMUTABLE`, y el fix de HNSW necesita exactamente eso.

**Fix.** `volatile`. Cuesta algo de capacidad de optimización del planner y no
hay alternativa.

---

## 3. `sum(numeric)` contra un retorno `float`

**Síntoma.** Arreglado lo anterior, la llamada empezó a fallar con
`Returned type numeric does not match expected type double precision in column 10`.

**Causa.** `sum(1.0 / int)` devuelve `numeric` en PL/pgSQL. El tipo de retorno
declara `rrf_score float`. La versión previa era `language sql` y Postgres
hacía el cast implícito — el error apareció recién al pasarla a `plpgsql` para
poder usar `SET LOCAL`.

**Fix.** Cast explícito en los dos niveles: `(1.0 / (k + rnk))::float` y
`sum(...)::float`.

**La lección.** Tres bugs encadenados, cada uno causado por arreglar el
anterior. Vale la pena anotarlos juntos: por separado, ninguno de los tres
tiene sentido.

---

## 4. Migraciones que no se pueden re-aplicar

**Síntoma.** Un entorno quedaba a medio migrar y la migración siguiente fallaba
al correrla de nuevo.

**Causa.** `drop function ... (uuid, text, vector, int, int, uuid[])` necesita
la signature exacta. Mientras se itera sobre la función, la signature cambia, y
el `drop` de la migración nueva no encuentra la versión vieja.

**Fix.** Borrar por nombre recorriendo `pg_proc`, sin conocer las signatures.

**La lección.** Una migración tiene que poder correrse dos veces. El momento en
que eso importa es justo cuando algo ya salió mal.

---

## 5. El umbral de rechazo

La búsqueda híbrida **siempre** devuelve resultados: por mal que matcheen, los
k primeros chunks salen igual. Sin un piso de puntaje, una pregunta sobre un
tema que no está en el corpus recupera los fragmentos menos malos y el modelo,
obediente, arma una respuesta citándolos.

Eso es peor que un "no sé", porque las citas son reales: apuntan a pasajes que
existen y que el usuario puede ir a verificar. Lo que no existe es la relación
entre esos pasajes y la pregunta.

`MIN_RRF_SCORE` se calibra contra el corpus propio. No hay un valor universal.

---

## 6. La metadata ausente se declara, no se omite

Pedirle a un modelo una cita en APA sobre un corpus sin año de publicación
produce años inventados. No porque el modelo mienta, sino porque el formato APA
espera un año y nada en el prompt dice que ese dato no existe.

La solución es una línea por campo faltante:

```
AÑO=(no registrado — usá «s.f.» en APA)
EDITORIAL=(no registrada — omití en APA)
```

Es el mismo principio que un fallo ruidoso en vez de silencioso: la ausencia de
un dato tiene que ser visible.

---

## 7. La alucinación del planificador

El planificador de consultas también alucina, y es más difícil de detectar.

Ante un mensaje vago sobre un dominio conocido, propone consultas con autores
que "deberían" estar en ese corpus pero que nunca se cargaron. El motor busca
material inexistente, no encuentra nada, y el sistema responde que no tiene
información — cuando sí la tenía, bajo otros nombres.

El fallo ocurre antes de la recuperación, así que una evaluación que solo mire
la respuesta final lo registra como "el corpus no cubría el tema".

**Fix.** Pasarle al planificador la lista real de documentos de la colección
como ancla.

---

## 8. BM25 trata los términos como AND

El lado sparse de la búsqueda híbrida penaliza las consultas largas. Agregar
palabras de andamiaje —"ideas principales", "resumen", "conceptos"— parece
enriquecer la consulta y en realidad la rompe: cada término adicional es un
requisito más que el documento debe cumplir.

Por eso el prompt del planificador prohíbe explícitamente ese vocabulario. Si
el documento se titula *Modelos de democracia*, la consulta es
`Lijphart modelos democracia`, no `ideas principales de Lijphart sobre los
modelos de democracia`.

Es un caso donde la intuición de "más contexto es mejor" —cierta para el lado
denso— es exactamente falsa para el lado sparse, y la búsqueda híbrida tiene
que convivir con ambas.
