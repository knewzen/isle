import {Constants} from "../constants";
import resource from 'resource-router-middleware';
const rp = require('request-promise');

let reqOpts = {
  method: 'POST',
  headers: {
    'X-Dgraph-CommitNow': 'true'
  }
};

const makePost = function(body, res) {
  // Add the post
  let createPost =
        `{
          set {
            _:newPost <content.title> "${body.title}" .
            _:newPost <content.imageUri> "${body.imageUri}" .
            _:newPost <content.body> "${body.body}" .
            _:newPost <content.created> "${(new Date()).toISOString()}" .
            _:newPost <content.score> "0" .
            <${body.userId}> <user.commented> _:newPost .
          }
        }`;

  // TODO: Tags
  reqOpts.uri = Constants.dbUrl + 'mutate';
  reqOpts.body = createPost;
  return rp(reqOpts)
    .then((queryRes) => {
      console.log(queryRes);
      queryRes = JSON.parse(queryRes);
      if (queryRes.data === null) {
        res.status(500).send(queryRes.errors);

        return;
      }
      res.send({message: queryRes.data});
    })
};

const buildParentTree = function(parentTree, treeArr) {
  // Flatten the tree
  treeArr.push({
    sentiment: parentTree.sentiment,
    score: parentTree.score,
    poster: parentTree.poster
  });
  if (parentTree.parent) {
    parentTree = parentTree.parent;
    treeArr.push({
      sentiment: parentTree.sentiment,
      score: parentTree.score,
      poster: parentTree.poster
    });
    if (parentTree.parent) {
      parentTree = parentTree.parent;
      treeArr.push({
        sentiment: parentTree.sentiment,
        score: parentTree.score,
        poster: parentTree.poster
      });
    }
  }

  return treeArr;
};

const makeComment = function(body, res) {

  // Get the user's current rep
  const fetchContentFrag =
        `uid: _uid_
        sentiment: content.sentiment
        score: content.score
        poster: ~user.commented {
          uid: _uid_
          rep: user.reputation
          parent: user.invitedBy {
            uid: _uid_ 
            rep: user.reputation
          }
        }`;

  // Depth 3 tree fetch
  const fetchContentTree =
        `{
          fetchContentTree(func: uid(${body.parentId})) {
            ${fetchContentFrag}
            parent: ~content.children {
              ${fetchContentFrag}
              parent: ~content.children {
                ${fetchContentFrag}
              }
            }
          }  
        }`;

  reqOpts.uri = Constants.dbUrl + 'query';
  reqOpts.body = fetchContentTree;
  rp(reqOpts)
    .then((queryRes) => {
      queryRes = JSON.parse(queryRes);
      if (queryRes.data === null) {
        console.error(queryRes.errors);
        res.status(500).send(queryRes.errors);

        return;
      }

      let treeArr = [{sentiment: body.sentiment}];
      treeArr = buildParentTree(queryRes.data, treeArr);

      // Walk the flattened tree and calc reputation/score
      let workingSentiment = body.sentiment;
      treeArr = treeArr.map((post, idx) => {
        if (idx === 0) {return post}
        const delta = (workingSentiment/idx) * treeArr[idx-1].sentiment;
        workingSentiment = workingSentiment * treeArr[idx-1].sentiment;
        post.score = post.score + delta;
        post.poster.rep = post.poster.rep + delta;
        if (post.poster.parent) {
          post.poster.parent.rep = post.poster.parent.rep + (delta / 2);
        }

        return post;
      });

      // Add the post
      let createPost =
            `{
              set {
                _:newPost <content.body> "${body.body}" .
                _:newPost <content.created> "${(new Date()).toISOString()}" .
                _:newPost <content.score> "0" .
                <${body.userId}> <user.commented> _:newPost .
          `;

      // Put together the score/rep changes
      treeArr.slice(1).forEach((post) => {
        createPost = createPost.concat(`<${post.uid}> <content.score> ${post.score}`+'\n');
        createPost = createPost.concat(`<${post.poster.uid}> <user.reputation> ${post.poster.rep}`+'\n');
        if (post.poster.parent) {
          createPost = createPost.concat(`<${post.poster.parent.uid}> <user.reputation> ${post.poster.parent.rep}`+'\n');
        }
      });

      createPost.concat(`
              }
            }`);

      // TODO: Tags

      console.log(createPost);

      reqOpts.uri = Constants.dbUrl + 'mutate';
      reqOpts.body = createPost;
      return rp(reqOpts);
    })
    .then((queryRes) => {
      queryRes = JSON.parse(queryRes);
      if (queryRes.data === null) {
        console.error(queryRes.errors);
        res.status(500).send(queryRes.errors);

        return;
      }
      res.send({message: queryRes.data});
    })
};

const basePost =
  `title: content.title@.
  imageUri: content.imageUri
  timestamp: content.created
  score: content.score
  submitted: ~user.posted {
      user.name@.
  }
  tags: content.tags {
      tag.text@.
  }
  numComments: count(content.children)`;

const commentFragment =
  `score: content.score
  text: content.body
  sentiment: content.sentiment
  commented: ~user.posted {
      user.name@.
  }`;

export default ({config}) => resource({
    /** GET / - List all entities */
    index({params}, res) {
      const queryPost =
        `{
          var(func: anyoftext(content.title, "${params.query}"), first: ${params.first}, offset: ${params.offset}) {
              p as _uid_
          }
      
          queryPosts(func: uid(p), orderasc: content.created) {
              ${basePost}
          }
        }`;

      reqOpts.uri = Constants.dbUrl + 'query';
      reqOpts.body = queryPost;
      return rp(reqOpts)
        .then((queryRes) => {
          queryRes = JSON.parse(queryRes);
          if (queryRes.data === null) {
            console.error(queryRes.errors);
            res.status(500).json(queryRes.errors);

            return;
          }
          res.status(200).json(queryRes.data);
        })
    },

    /** POST / - Create a new top level post */
    create({body}, res) {
      // IMPORTANT NOTE: for now posts and comments are treated mostly the same
      if (body.title) {
        makePost(body, res);
      } else {
        makeComment(body, res);
      }
    },

    /** GET /:id - Return a given entity */
    read(req, res) {
      const id = req.params[undefined];
      const queryPost =
        `fetchPost(func: uid(${id})) {
          ${basePost}
          body: content.body
          
          ## Print out 3 layers of comments
          comments: content.children {
              ${commentFragment}
                  comments: content.children {
                      ${commentFragment}
                      comments: content.children {
                          ${commentFragment}
                      }
                  }
          }
	    }`;

      reqOpts.uri = Constants.dbUrl + 'query';
      reqOpts.body = queryPost;
      return rp(reqOpts)
        .then((queryRes) => {
          queryRes = JSON.parse(queryRes);
          if (queryRes.data === null) {
            console.error(queryRes.errors);
            res.status(500).json(queryRes.errors);

            return;
          }
          res.status(200).json(queryRes.data);
        })
    },
    //
    // /** PUT /:id - Update a given entity */
    // update({facet, body}, res) {
    //   for (let key in body) {
    //     if (key !== 'id') {
    //       facet[key] = body[key];
    //     }
    //   }
    //   res.sendStatus(204);
    // },
    //
    // /** DELETE /:id - Delete a given entity */
    // delete({facet}, res) {
    //   facets.splice(facets.indexOf(facet), 1);
    //   res.sendStatus(204);
    // }
});
